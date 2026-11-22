import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  BackgroundJob,
  JobPublisher,
  MemoryStore,
  SecretStore,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR, RetryJobLaterError } from "@rakazo/adapter-kit";
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
  readMessageBlocks,
  recordUsage,
  runAsSystem,
  runAsTenant,
  withLease,
} from "@rakazo/db";
import * as z from "zod";
import { loadCommandVariables, loadLoginPasswordRedactions } from "./bot-secrets.js";
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
import { editMemory } from "./memory-tools.js";
import { redactBlocks } from "./run-messages.js";
import { messageBlocksText } from "./run-replies.prompt.js";
import { isUserProgressClientNonce } from "./user-progress.js";
import { byteLength } from "./utf8.js";

/** A review starts at once when this many of the owner's turns wait. */
export const LEARNING_REVIEW_BATCH = 10;
/** Fewer wait for a pause this long after the owner's last turn. */
export const LEARNING_IDLE_MS = 15 * 60_000;
/** One review's model call may take this long. */
export const LEARNING_REVIEW_TIMEOUT_MS = 90_000;
/**
 * A review started at once has a backup job due once its attempt is surely over: the role
 * model's call, the bot's own model after it fails, then reading and saving.
 */
export const LEARNING_REVIEW_BACKUP_MS = 2 * LEARNING_REVIEW_TIMEOUT_MS + 3 * 60_000;
/** A job that finds another process reviewing the bot looks again this much later. */
const HELD_RETRY_MS = 2 * 60_000;
/** What one review reads of the conversation, newest kept. */
const TRANSCRIPT_MAX_CHARS = 16_000;
/** The most waiting turns one review reads; older ones are dropped with them. */
const TURNS_READ = 100;
const LEASE_TTL_MS = 60_000;
const MEMORY_SAVE_ATTEMPTS = 3;

export type DozoLearningMemory = Pick<MemoryStore, "read" | "commit">;
type Bot = { id: string; spaceId: string; userId: string };
type Model = AgentRunRequest["model"];

export type LearningReviewDeps = {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  memory: DozoLearningMemory;
  /** Opens the owner's saved values, which a review hides as a run does. */
  secretStore: Pick<SecretStore, "load">;
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
  // An add is the remember tool's: appended once, refused past the cap.
  for (const op of adds) {
    const current = joinLines(lines);
    const edit = editMemory(current, op.text, "", maxBytes);
    if ("error" in edit || edit.content === current) continue;
    lines = linesOf(edit.content);
    applied.push({ kind: "add", before: null, after: op.text });
  }
  return { content: applied.length ? joinLines(lines) : content, applied };
}

/** A card that asked for a secret or a code is left out with its message. */
const asksSecret = (blocks: MessageBlock[]) =>
  blocks.some(
    (block) => block.kind === "ask" && (block.input === "secret" || Boolean(block.oneTimeCode)),
  );

/**
 * A message's text with every saved value hidden as a run hides it. A message whose blocks cannot
 * all be read is left out: a missing block could have been the one that made it private.
 */
function textOf(message: { id: string; blocks: unknown }, secrets: string[]): string {
  const { blocks, intact } = readMessageBlocks(message);
  if (!intact || asksSecret(blocks)) return "";
  return messageBlocksText(redactBlocks(blocks, secrets)).trim();
}

/** The values a run of the bot hides: saved logins, cards, keys and command variables. */
async function savedValues(deps: Pick<LearningReviewDeps, "prisma" | "secretStore">, bot: Bot) {
  const scope = { userId: bot.userId, spaceId: bot.spaceId, botId: bot.id };
  const [logins, variables] = await Promise.all([
    loadLoginPasswordRedactions(deps.prisma, deps.secretStore, scope),
    loadCommandVariables(deps.prisma, deps.secretStore, scope),
  ]);
  return [...logins, ...variables.redactions];
}

/**
 * Each turn as the review reads it: the owner's own words, and for a turn no outside content
 * entered, the bot's final reply. Oldest first, newest kept within the cap.
 */
export async function learningTranscript(
  prisma: Pick<PrismaClient, "message">,
  owner: string,
  turns: LearningTurn[],
  secrets: string[],
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
  const said = new Map(sources.map((message) => [message.id, textOf(message, secrets)]));
  const finalReply = new Map<string, string>();
  for (const reply of replies) {
    if (isPartialReplyClientNonce(reply.clientNonce)) continue;
    if (isUserProgressClientNonce(reply.clientNonce)) continue;
    const text = textOf(reply, secrets);
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

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;

/** The runtime's own failure text, as compaction reads it: a transient error, tried again. */
const RUNTIME_FAILURE = /^(?:I hit a problem:|Unknown model )/i;

/**
 * One tool-less call on the member's compaction role model, falling back to the bot's own model
 * as compaction does. Usage is recorded as setup under the bot. A failed call, the runtime's own
 * failure text and an empty answer throw, so the turns wait for another try. Null without a model
 * that can answer (none connected), as compaction skips.
 */
async function askReviewModel(
  deps: LearningReviewDeps,
  bot: Bot,
  operationId: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string | null> {
  const scope = { userId: bot.userId, spaceId: bot.spaceId, botId: bot.id };
  const record = async (event: UsageEvent) => {
    await recordUsage(deps.prisma, event, { ...scope, operationId, operationKind: "setup" });
  };
  let answer: string | null = null;
  await compactWithRoleModel(deps.prisma, deps, async (resolveModel) => {
    const model = await (resolveModel ?? deps.resolveModel)(scope);
    answer = null;
    if (!deps.runtime.describe().capabilities.compaction || model.provider === "scripted") return;
    let text = "";
    let failed = false;
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
        signal: deadlineSignal(LEARNING_REVIEW_TIMEOUT_MS, signal),
      },
    )) {
      if (event.type === "usage" && !event.accounted) await record(event);
      if (event.type === "text" && RUNTIME_FAILURE.test(event.text.trim())) failed = true;
      if (event.type === "done" && event.text) text = event.text.trim();
    }
    if (failed || RUNTIME_FAILURE.test(text)) throw new Error("learning review model call failed");
    if (!text) throw new Error("learning review model answered nothing");
    answer = text;
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
  const transcript = await learningTranscript(
    deps.prisma,
    bot.userId,
    turns,
    await savedValues(deps, bot),
  );
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
  // No model that can answer: the turns wait for one.
  if (answer === null) return;
  // Turned off while the model answered: nothing is learned from these turns.
  if ((await learningMode(deps.prisma, bot.id)) !== "auto") {
    return consumeLearningTurns(deps.prisma, bot.id, turns);
  }
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
 * answers "held". Runs in the bot owner's tenant context.
 */
export async function reviewLearning(
  deps: LearningReviewDeps,
  botId: string,
): Promise<"held" | undefined> {
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
    return "held";
  }
  return undefined;
}

/** The job that runs a review: the backup of one under way, or the one after a pause. */
export function dozoLearningReviewJob(deps: {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  jobs: JobPublisher;
  memory: DozoLearningMemory;
  secretStore: Pick<SecretStore, "load">;
  executor: Pick<LearningReviewDeps, "resolveModel" | "resolveConnectedModel">;
}) {
  return async ({ botId }: { botId: string }) => {
    const owner = await runAsSystem("find the bot a learning review is for", () =>
      deps.prisma.bot.findUnique({ where: { id: botId }, select: { spaceId: true, userId: true } }),
    );
    if (!owner) return;
    const outcome = await runAsTenant(owner, () =>
      reviewLearning(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          memory: deps.memory,
          secretStore: deps.secretStore,
          resolveModel: deps.executor.resolveModel,
          resolveConnectedModel: deps.executor.resolveConnectedModel,
        },
        botId,
      ),
    );
    // The review under way may still fail and leave the turns: look again once it is over.
    if (outcome === "held") throw new RetryJobLaterError(HELD_RETRY_MS);
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
  const { botId: _botId, supersededBy, ...shown } = change;
  if (change.undoneAt) return shown;
  // A later change took its line over: the line is that change's, or the owner's.
  if (supersededBy) throw new DozoLearningChangedError();
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
