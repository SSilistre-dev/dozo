import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  BackgroundJob,
  JobPublisher,
  MemoryStore,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { DozoLearningChange, MessageBlock } from "@rakazo/contracts";
import {
  BOT_MEMORY_MAX_BYTES,
  DOZO_LEARNING_CHANGED_CODE,
  MEMORY_INDEX_PATH,
} from "@rakazo/contracts";
import { ClientError, deadlineSignal, retry } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  isPartialReplyClientNonce,
  LeaseHeldError,
  recordUsage,
  runAsSystem,
  runAsTenant,
  storedMessageBlocks,
  withLease,
} from "@rakazo/db";
import * as z from "zod";
import type { CompactionModelSources } from "./dozo-compaction-model.js";
import { compactWithRoleModel } from "./dozo-compaction-model.js";
import type { LearningTranscriptLine } from "./dozo-learning-review.prompt.js";
import {
  LEARNING_MAX_CHANGES,
  LEARNING_NOTE_MAX_CHARS,
  learningReviewInstructions,
  learningReviewPrompt,
} from "./dozo-learning-review.prompt.js";
import type { LearningChangeInput, LearningTurn } from "./dozo-learning-store.js";
import {
  consumeLearningTurns,
  findLearningChange,
  learnedLines,
  learningMode,
  markLearningChangeUndone,
  pendingLearningTurns,
  saveLearningChanges,
} from "./dozo-learning-store.js";
import { messageBlocksText } from "./run-replies.prompt.js";
import { isUserProgressClientNonce } from "./user-progress.js";
import { byteLength } from "./utf8.js";

/** A review starts at once when this many of the owner's turns wait. */
export const LEARNING_REVIEW_BATCH = 10;
/** Fewer wait for a pause this long after the owner's last turn. */
export const LEARNING_IDLE_MS = 15 * 60_000;
/** One review's model call may take this long. */
const REVIEW_TIMEOUT_MS = 90_000;
/** A review started at once has a backup job due once its attempt is surely over. */
export const LEARNING_REVIEW_BACKUP_MS = REVIEW_TIMEOUT_MS + 2 * 60_000;
/** What one review reads of the conversation, newest kept. */
const TRANSCRIPT_MAX_CHARS = 16_000;
/** The most waiting turns one review reads; older ones are dropped with them. */
const TURNS_READ = 100;
const LEASE_TTL_MS = 60_000;
const MEMORY_SAVE_ATTEMPTS = 3;

export type DozoLearningMemory = Pick<MemoryStore, "read" | "commit">;
type Model = AgentRunRequest["model"];

export type LearningReviewDeps = {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  memory: DozoLearningMemory;
  /** The bot's own model, which a review falls back to as compaction does. */
  resolveModel: (scope: { userId: string; spaceId: string; botId?: string }) => Promise<Model>;
  resolveConnectedModel: CompactionModelSources["resolveConnectedModel"];
};

export const learningReviewJobKey = (botId: string) => `learning.review:${botId}`;

/** The bot's one review job: the backup of a review under way, or the wait for a pause. */
export function learningReviewJob(botId: string, availableAt: Date): BackgroundJob {
  return {
    name: "memory.learning-review",
    payload: { botId },
    availableAt,
    replaceKey: learningReviewJobKey(botId),
  };
}

const NoteText = z
  .string()
  .trim()
  .min(1)
  .max(LEARNING_NOTE_MAX_CHARS)
  .refine((text) => !/[\r\n]/.test(text));

/** The answer's contract; anything else applies nothing. */
const Answer = z
  .object({
    changes: z
      .array(
        z.discriminatedUnion("op", [
          z.object({ op: z.literal("add"), text: NoteText }).strict(),
          z.object({ op: z.literal("update"), id: z.string(), text: NoteText }).strict(),
          z.object({ op: z.literal("remove"), id: z.string() }).strict(),
        ]),
      )
      .max(LEARNING_MAX_CHANGES),
  })
  .strict();
export type LearningOp = z.infer<typeof Answer>["changes"][number];

/** The JSON object in a reply, also when the model wrapped it in a code fence. */
function jsonObjectIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** The changes a reply asks for, or null when it breaks the contract or names an unknown id. */
export function parseLearningAnswer(text: string, ids: ReadonlySet<string>): LearningOp[] | null {
  const parsed = Answer.safeParse(jsonObjectIn(text));
  if (!parsed.success) return null;
  const { changes } = parsed.data;
  return changes.every((change) => change.op === "add" || ids.has(change.id)) ? changes : null;
}

const linesOf = (content: string) => content.replace(/\r\n/g, "\n").split("\n");

/** The lines with the trailing empty ones dropped, so one more goes at the end. */
const withoutTrailingBlank = (lines: string[]) => linesOf(joinLines(lines)).slice(0, -1);

function joinLines(lines: string[]): string {
  const kept = [...lines];
  while (kept.length && kept.at(-1) === "") kept.pop();
  return kept.length ? `${kept.join("\n")}\n` : "";
}

/**
 * The notes with a review's changes applied, and what was applied. An update or a remove reaches
 * only the review's own line (`own`: id to line), and only while it is still there as written;
 * an add is appended. Edits to own lines come first, so they can make room: a change that would
 * grow the notes past `maxBytes` is dropped. The owner's lines are never touched.
 */
export function applyLearningOps(
  content: string,
  ops: LearningOp[],
  own: ReadonlyMap<string, string>,
  maxBytes = BOT_MEMORY_MAX_BYTES,
): { content: string; applied: LearningChangeInput[] } {
  let lines = linesOf(content);
  const applied: LearningChangeInput[] = [];
  const fits = (next: string[]) => {
    const bytes = byteLength(joinLines(next));
    return bytes <= maxBytes || bytes <= byteLength(joinLines(lines));
  };
  const present = (text: string) => lines.some((line) => line.trim() === text);
  const edits = ops.filter((op) => op.op !== "add");
  const adds = ops.filter((op) => op.op === "add");
  for (const op of edits) {
    const line = own.get(op.id);
    const at = line === undefined ? -1 : lines.indexOf(line);
    if (line === undefined || at < 0) continue;
    if (op.op === "remove") {
      lines = lines.filter((_, index) => index !== at);
      applied.push({ kind: "remove", before: line, after: null });
      continue;
    }
    if (op.text === line || present(op.text)) continue;
    const next = lines.map((value, index) => (index === at ? op.text : value));
    if (!fits(next)) continue;
    lines = next;
    applied.push({ kind: "update", before: line, after: op.text });
  }
  for (const op of adds) {
    if (present(op.text)) continue;
    const next = [...withoutTrailingBlank(lines), op.text];
    if (!fits(next)) continue;
    lines = next;
    applied.push({ kind: "add", before: null, after: op.text });
  }
  return { content: applied.length ? joinLines(lines) : content, applied };
}

/** A message that asked for or carried a secret is left out whole. */
function carriesSecret(blocks: MessageBlock[]): boolean {
  return blocks.some(
    (block) =>
      (block.kind === "ask" && (block.input === "secret" || Boolean(block.oneTimeCode))) ||
      ["credentials", "api_key", "env"].includes(block.kind),
  );
}

const textOf = (message: { id: string; blocks: unknown }) => {
  const blocks = storedMessageBlocks(message);
  return carriesSecret(blocks) ? "" : messageBlocksText(blocks).trim();
};

/**
 * Each turn as the review reads it: the owner's own words, and for a turn no outside content
 * entered, the bot's final reply. Oldest first, newest kept within the cap.
 */
export async function learningTranscript(
  prisma: Pick<PrismaClient, "message">,
  owner: string,
  turns: LearningTurn[],
): Promise<LearningTranscriptLine[][]> {
  const [sources, replies] = await Promise.all([
    prisma.message.findMany({
      where: {
        id: { in: turns.map((turn) => turn.messageId) },
        role: "user",
        OR: [{ authorUserId: owner }, { authorUserId: null }],
      },
      select: { id: true, blocks: true },
    }),
    prisma.message.findMany({
      where: {
        runId: { in: turns.filter((turn) => !turn.tainted).map((turn) => turn.runId) },
        role: "bot",
      },
      orderBy: { seq: "asc" },
      select: { id: true, runId: true, blocks: true, clientNonce: true },
    }),
  ]);
  const said = new Map(sources.map((message) => [message.id, textOf(message)]));
  const finalReply = new Map<string, string>();
  for (const reply of replies) {
    if (isPartialReplyClientNonce(reply.clientNonce)) continue;
    if (isUserProgressClientNonce(reply.clientNonce)) continue;
    const text = textOf(reply);
    if (reply.runId && text) finalReply.set(reply.runId, text);
  }
  const kept: LearningTranscriptLine[][] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    const owned = said.get(turn.messageId);
    if (!owned) continue;
    const lines: LearningTranscriptLine[] = [{ speaker: "owner", text: owned }];
    // A tainted turn's replies were never read.
    const reply = finalReply.get(turn.runId);
    if (reply) lines.push({ speaker: "bot", text: reply });
    const size = lines.reduce((sum, line) => sum + line.text.length, 0);
    if (used + size > TRANSCRIPT_MAX_CHARS) {
      if (!kept.length)
        kept.push([{ speaker: "owner", text: owned.slice(0, TRANSCRIPT_MAX_CHARS) }]);
      break;
    }
    used += size;
    kept.push(lines);
  }
  return kept.reverse();
}

type Bot = { id: string; spaceId: string; userId: string };
type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;

/** The runtime's own failure text, as compaction reads it: a transient error, tried again. */
const RUNTIME_FAILURE = /^(?:I hit a problem:|Unknown model )/i;

/**
 * One tool-less call on the member's compaction role model, falling back to the bot's own model
 * as compaction does. Usage is recorded as setup under the bot. A failed call throws.
 */
async function askReviewModel(
  deps: LearningReviewDeps,
  bot: Bot,
  operationId: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const scope = { userId: bot.userId, spaceId: bot.spaceId, botId: bot.id };
  const record = async (event: UsageEvent) => {
    await recordUsage(deps.prisma, event, { ...scope, operationId, operationKind: "setup" });
  };
  let answer = "";
  await compactWithRoleModel(deps.prisma, deps, async (resolveModel) => {
    const model = await (resolveModel ?? deps.resolveModel)(scope);
    answer = "";
    for await (const event of deps.runtime.run(
      {
        botId: bot.id,
        threadId: operationId,
        runId: operationId,
        usageOperationKind: "setup",
        onUsage: record,
        prompt,
        instructions: learningReviewInstructions(),
        history: [],
        tools: [],
        model: { ...model, thinkingLevel: "off" },
        allowSilentEmpty: true,
      },
      {
        operationId,
        traceId: operationId,
        ...scope,
        signal: deadlineSignal(REVIEW_TIMEOUT_MS, signal),
      },
    )) {
      if (event.type === "usage" && !event.accounted) await record(event);
      if (event.type === "done" && event.text) answer = event.text;
    }
    if (RUNTIME_FAILURE.test(answer.trim())) throw new Error("learning review model call failed");
  });
  return answer;
}

/** The review's own lines in the notes, newest change first, each once, with short ids. */
async function ownLines(prisma: PrismaClient, botId: string, content: string) {
  const lines = new Set(linesOf(content));
  const own = new Map<string, string>();
  const seen = new Set<string>();
  for (const learned of await learnedLines(prisma, botId)) {
    if (!lines.has(learned.after) || seen.has(learned.after)) continue;
    seen.add(learned.after);
    own.set(`n${own.size + 1}`, learned.after);
  }
  return own;
}

const memoryContext = (bot: Bot, signal: AbortSignal) => ({
  operationId: `learning:${bot.id}`,
  traceId: `learning:${bot.id}`,
  spaceId: bot.spaceId,
  userId: bot.userId,
  botId: bot.id,
  signal,
});

const overtaken = (error: unknown) =>
  error instanceof Error && error.message === MEMORY_REVISION_CONFLICT_ERROR;

/**
 * Reads the bot's notes, edits them and saves them at the revision read, reading again when
 * another write got in first. An edit that changes nothing saves nothing.
 */
function editNotes<T>(
  memory: DozoLearningMemory,
  botId: string,
  context: Parameters<DozoLearningMemory["read"]>[1],
  edit: (content: string) => { content: string; result: T },
): Promise<T> {
  const path = MEMORY_INDEX_PATH;
  return retry(
    async () => {
      const [existing] = (await memory.read({ scope: "bot", botId, path }, context)).documents;
      const content = existing?.content ?? "";
      const next = edit(content);
      if (next.content !== content) {
        const expectedRevision = existing?.revision ?? 0;
        await memory.commit(
          { scope: "bot", botId, path, content: next.content, expectedRevision },
          context,
        );
      }
      return next.result;
    },
    { attempts: MEMORY_SAVE_ATTEMPTS, retryable: overtaken, delayMs: 0 },
  );
}

/** Applies the answer to the notes as they are now. */
function saveNotes(
  deps: LearningReviewDeps,
  bot: Bot,
  ops: LearningOp[],
  labels: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<LearningChangeInput[]> {
  return editNotes(deps.memory, bot.id, memoryContext(bot, signal), (content) => {
    // A label still names its change; the line counts only while it is still there.
    const present = new Set(linesOf(content));
    const own = new Map([...labels].filter(([, line]) => present.has(line)));
    const edit = applyLearningOps(content, ops, own);
    return { content: edit.content, result: edit.applied };
  });
}

async function review(deps: LearningReviewDeps, bot: Bot, signal: AbortSignal): Promise<void> {
  const turns = await pendingLearningTurns(deps.prisma, bot.id, TURNS_READ);
  const first = turns[0];
  if (!first) return;
  const transcript = await learningTranscript(deps.prisma, bot.userId, turns);
  if (!transcript.length) return consumeLearningTurns(deps.prisma, bot.id, turns);
  const [notes] = (
    await deps.memory.read(
      { scope: "bot", botId: bot.id, path: MEMORY_INDEX_PATH },
      memoryContext(bot, signal),
    )
  ).documents;
  const content = notes?.content ?? "";
  const own = await ownLines(deps.prisma, bot.id, content);
  const yours = new Set(own.values());
  const prompt = learningReviewPrompt({
    transcript,
    yours: [...own].map(([id, text]) => ({ id, text })),
    owners: linesOf(content).filter((line) => line.trim() && !yours.has(line)),
  });
  // A failed call keeps the turns: the job tries again.
  const answer = await askReviewModel(deps, bot, `learning:${bot.id}:${first.id}`, prompt, signal);
  const ops = parseLearningAnswer(answer, new Set(own.keys()));
  const applied = ops?.length ? await saveNotes(deps, bot, ops, own, signal) : [];
  if (applied.length) {
    await saveLearningChanges(deps.prisma, bot, turns.at(-1)?.threadId ?? null, applied);
  }
  // An answer that broke the contract is not asked again for the same turns.
  await consumeLearningTurns(deps.prisma, bot.id, turns);
}

/**
 * Reviews the bot's waiting turns once, when its owner has learning on. One review per bot runs
 * at a time across processes: while another holds the bot, this one leaves the turns to it and
 * to the bot's job. Runs in the bot owner's tenant context.
 */
export async function reviewLearning(deps: LearningReviewDeps, botId: string): Promise<void> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId },
    select: { id: true, spaceId: true, userId: true },
  });
  if (!bot || (await learningMode(deps.prisma, botId)) !== "auto") return;
  try {
    await withLease(deps.prisma, `dozo-learning:${botId}`, { ttlMs: LEASE_TTL_MS }, (lease) =>
      review(deps, bot, lease.signal),
    );
  } catch (error) {
    if (!(error instanceof LeaseHeldError)) throw error;
  }
}

/** The job that runs a review: the backup of one under way, or the one after a pause. */
export function dozoLearningReviewJob(deps: {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  jobs: JobPublisher;
  memory: DozoLearningMemory;
  executor: Pick<LearningReviewDeps, "resolveModel" | "resolveConnectedModel">;
}) {
  return async ({ botId }: { botId: string }) => {
    const owner = await runAsSystem("find the bot a learning review is for", () =>
      deps.prisma.bot.findUnique({ where: { id: botId }, select: { spaceId: true, userId: true } }),
    );
    if (!owner) return;
    await runAsTenant(owner, () =>
      reviewLearning(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          memory: deps.memory,
          resolveModel: deps.executor.resolveModel,
          resolveConnectedModel: deps.executor.resolveConnectedModel,
        },
        botId,
      ),
    );
  };
}

/** The owner edited the line since: undoing would overwrite their words. */
export class DozoLearningChangedError extends ClientError {
  constructor() {
    super("CONFLICT", "This note was changed since it was learned.", DOZO_LEARNING_CHANGED_CODE);
  }
}

/** The notes with one change undone, or null when its line is no longer as the review left it. */
export function undoLearningEdit(
  content: string,
  change: Pick<DozoLearningChange, "kind" | "before" | "after">,
): string | null {
  const lines = linesOf(content);
  if (change.kind === "remove") {
    const before = change.before ?? "";
    return lines.includes(before) ? content : joinLines([...withoutTrailingBlank(lines), before]);
  }
  const at = lines.indexOf(change.after ?? "");
  if (at < 0) return null;
  if (change.kind === "add") return joinLines(lines.filter((_, index) => index !== at));
  return joinLines(lines.map((line, index) => (index === at ? (change.before ?? "") : line)));
}

/**
 * Undoes one change of the caller's Space and marks it undone. A put-back line may take the
 * notes past their cap, as an owner's edit may. Undoing twice changes nothing more.
 */
export async function undoLearningChange(
  deps: { prisma: PrismaClient; memory: DozoLearningMemory },
  actor: { spaceId: string; userId: string },
  changeId: string,
  checkBot: (botId: string) => Promise<unknown>,
): Promise<DozoLearningChange> {
  const change = await findLearningChange(deps.prisma, actor.spaceId, changeId);
  if (!change) throw new ClientError("NOT_FOUND", "This change no longer exists.");
  await checkBot(change.botId);
  const { botId: _botId, ...shown } = change;
  if (change.undoneAt) return shown;
  const context = {
    operationId: `learning-undo:${changeId}`,
    traceId: `learning-undo:${changeId}`,
    ...actor,
    botId: change.botId,
    signal: new AbortController().signal,
  };
  await editNotes(deps.memory, change.botId, context, (content) => {
    const next = undoLearningEdit(content, change);
    if (next === null) throw new DozoLearningChangedError();
    return { content: next, result: undefined };
  });
  await markLearningChangeUndone(deps.prisma, changeId);
  return { ...shown, undoneAt: new Date().toISOString() };
}
