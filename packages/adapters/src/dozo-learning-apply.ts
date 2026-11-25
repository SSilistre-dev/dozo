import { randomUUID } from "node:crypto";
import type { AdapterContext, BackgroundJob, JobPublisher, MemoryStore } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { DozoLearningChange } from "@rakazo/contracts";
import {
  BOT_MEMORY_MAX_BYTES,
  DOZO_LEARNING_CHANGED_CODE,
  DozoLearningNoteKind,
  DozoLearningNoteText,
  dozoLearningLine,
  MEMORY_INDEX_PATH,
} from "@rakazo/contracts";
import { ClientError, retry } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import * as z from "zod";
import {
  LEARNING_MAX_CHANGES,
  LEARNING_SKILL_LINE_MAX_CHARS,
  LEARNING_SKILL_MAX_INPUTS,
  LEARNING_SKILL_MAX_STEPS,
  LEARNING_SKILL_MIN_STEPS,
  LEARNING_SKILL_NAME_MAX_CHARS,
} from "./dozo-learning-review.prompt.js";
import type { LearningChangeInput } from "./dozo-learning-store.js";
import {
  findLearningChange,
  learnedLines,
  markLearningLinesOwnerEdited,
  markLearningUndoPending,
  pendingLearningWrites,
  saveLearningChanges,
  settleLearningWrite,
} from "./dozo-learning-store.js";
import { editMemory } from "./memory/memory-tools.js";
import { byteLength } from "../../core/src/primitives/utf8.js";

// What a review's answer may change in the bot's notes, how a change and its undo are written
// so the notes and the list of changes never disagree, and the owner's own edits.

export type DozoLearningMemory = Pick<MemoryStore, "read" | "commit">;
type Bot = { id: string; spaceId: string };
type Db = PrismaClient;

export type LearningEvents = Pick<ThreadEvents, "publishRosterChange">;

/**
 * After the bot's notes and its list of learned changes changed: a signal without content on the
 * owner's own topic (only they see the list), on which their open memory panel and learned list
 * read again.
 */
export async function learningChanged(events: LearningEvents | undefined, ownerId: string) {
  await events?.publishRosterChange?.({ userIds: [ownerId] });
}

const MEMORY_SAVE_ATTEMPTS = 3;
/**
 * A write of the notes is over well within this: one pending longer was cut short, and is settled
 * by whether its revision exists.
 */
export const LEARNING_WRITE_SETTLE_MS = 5 * 60_000;

const skillLine = dozoLearningLine(LEARNING_SKILL_LINE_MAX_CHARS);

/** A suggested skill as the answer gives it: one line per field, a bounded list of steps. */
const SkillSuggestion = z
  .object({
    name: dozoLearningLine(LEARNING_SKILL_NAME_MAX_CHARS),
    whenToUse: skillLine,
    inputs: z.array(dozoLearningLine(LEARNING_SKILL_NAME_MAX_CHARS)).max(LEARNING_SKILL_MAX_INPUTS),
    steps: z.array(skillLine).min(LEARNING_SKILL_MIN_STEPS).max(LEARNING_SKILL_MAX_STEPS),
    whatToReturn: skillLine,
  })
  .strict();
export type LearningSkillSuggestion = z.infer<typeof SkillSuggestion>;

/** The answer's contract; anything else applies nothing. */
const Answer = z
  .object({
    changes: z
      .array(
        z.discriminatedUnion("op", [
          z
            .object({
              op: z.literal("add"),
              kind: DozoLearningNoteKind,
              text: DozoLearningNoteText,
            })
            .strict(),
          z
            .object({
              op: z.literal("update"),
              id: z.string(),
              kind: DozoLearningNoteKind,
              text: DozoLearningNoteText,
            })
            .strict(),
          z.object({ op: z.literal("remove"), id: z.string() }).strict(),
        ]),
      )
      .max(LEARNING_MAX_CHANGES),
    // An answer of the first step has none.
    skill: SkillSuggestion.nullable().optional(),
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

/**
 * The changes and the skill a reply asks for, or null when it breaks the contract or names an
 * unknown id: then nothing of it is used, the skill neither.
 */
export function parseLearningReply(
  text: string,
  ids: ReadonlySet<string>,
): { ops: LearningOp[]; skill: LearningSkillSuggestion | null } | null {
  const parsed = Answer.safeParse(jsonObjectIn(text));
  if (!parsed.success) return null;
  const { changes, skill } = parsed.data;
  if (!changes.every((change) => change.op === "add" || ids.has(change.id))) return null;
  return { ops: changes, skill: skill ?? null };
}

/** The changes a reply asks for, or null when it breaks the contract or names an unknown id. */
export function parseLearningAnswer(text: string, ids: ReadonlySet<string>): LearningOp[] | null {
  return parseLearningReply(text, ids)?.ops ?? null;
}

/**
 * The one key a note is compared by against the lines the owner turned down: every run of
 * whitespace (what `\s` matches, no-break spaces included) is one space, the ends trimmed, and
 * case ignored, so a line written again with other spacing or case is the same line.
 */
export function learningNoteKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export const linesOf = (content: string) => content.replace(/\r\n/g, "\n").split("\n");

/** How many lines read exactly `line`: a change reaches a line only when it is the one. */
const countOf = (lines: readonly string[], line: string) =>
  lines.reduce((count, value) => count + (value === line ? 1 : 0), 0);

/** The lines with the trailing empty ones dropped, so one more goes at the end. */
const withoutTrailingBlank = (lines: string[]) => linesOf(joinLines(lines)).slice(0, -1);

function joinLines(lines: string[]): string {
  const kept = [...lines];
  while (kept.length && kept.at(-1) === "") kept.pop();
  return kept.length ? `${kept.join("\n")}\n` : "";
}

/**
 * The notes with a review's changes applied, and what was applied. An update or a remove reaches
 * only the review's own line (`own`: id to line), and only while exactly one line reads as it
 * wrote it; an add is appended. A line the owner turned down (`rejected`) is never written again,
 * in any spacing or case (learningNoteKey).
 * Edits to own lines come first, so they can make room: a change that would grow the notes past
 * `maxBytes` is dropped. The owner's lines are never touched.
 */
export function applyLearningOps(
  content: string,
  ops: LearningOp[],
  own: ReadonlyMap<string, string>,
  rejected: ReadonlySet<string> = new Set(),
  maxBytes = BOT_MEMORY_MAX_BYTES,
): { content: string; applied: LearningChangeInput[] } {
  let lines = linesOf(content);
  const applied: LearningChangeInput[] = [];
  const fits = (next: string[]) => {
    const bytes = byteLength(joinLines(next));
    return bytes <= maxBytes || bytes <= byteLength(joinLines(lines));
  };
  const present = (text: string) => lines.some((line) => line.trim() === text);
  const refused = new Set([...rejected].map(learningNoteKey));
  const turnedDown = (text: string) => refused.has(learningNoteKey(text));
  const edits = ops.filter((op) => op.op !== "add");
  const adds = ops.filter((op) => op.op === "add");
  for (const op of edits) {
    const line = own.get(op.id);
    if (line === undefined || countOf(lines, line) !== 1) continue;
    const at = lines.indexOf(line);
    if (op.op === "remove") {
      lines = lines.filter((_, index) => index !== at);
      applied.push({ kind: "remove", before: line, after: null });
      continue;
    }
    if (op.text === line || present(op.text) || turnedDown(op.text)) continue;
    const next = lines.map((value, index) => (index === at ? op.text : value));
    if (!fits(next)) continue;
    lines = next;
    applied.push({ kind: "update", before: line, after: op.text });
  }
  // An add is the remember tool's: appended once, refused past the cap.
  for (const op of adds) {
    if (turnedDown(op.text)) continue;
    const current = joinLines(lines);
    const edit = editMemory(current, op.text, "", maxBytes);
    if ("error" in edit || edit.content === current) continue;
    lines = linesOf(edit.content);
    applied.push({ kind: "add", before: null, after: op.text });
  }
  return { content: applied.length ? joinLines(lines) : content, applied };
}

/**
 * The notes with one change undone, or null when its line is no longer exactly once as the
 * review left it.
 */
export function undoLearningEdit(
  content: string,
  change: Pick<DozoLearningChange, "kind" | "before" | "after">,
): string | null {
  const lines = linesOf(content);
  if (change.kind === "remove") {
    const before = change.before ?? "";
    return lines.includes(before) ? content : joinLines([...withoutTrailingBlank(lines), before]);
  }
  const after = change.after ?? "";
  if (countOf(lines, after) !== 1) return null;
  const at = lines.indexOf(after);
  if (change.kind === "add") return joinLines(lines.filter((_, index) => index !== at));
  return joinLines(lines.map((line, index) => (index === at ? (change.before ?? "") : line)));
}

const overtaken = (error: unknown) =>
  error instanceof Error && error.message === MEMORY_REVISION_CONFLICT_ERROR;

const newWriteTag = () => `dozo-learning:${randomUUID()}`;

async function readNotes(memory: DozoLearningMemory, botId: string, context: AdapterContext) {
  const path = MEMORY_INDEX_PATH;
  const [existing] = (await memory.read({ scope: "bot", botId, path }, context)).documents;
  return { content: existing?.content ?? "", revision: existing?.revision ?? 0 };
}

/**
 * Whether the write tagged `tag` reached the bot's notes: the revision it made carries the tag.
 * Read from the Markdown store's history, the store bot notes live in.
 */
export async function learningWriteLanded(
  prisma: Pick<Db, "memoryRevision">,
  bot: Bot,
  tag: string,
): Promise<boolean> {
  const revision = await prisma.memoryRevision.findFirst({
    where: {
      sourceRunId: tag,
      document: { spaceId: bot.spaceId, scope: "bot", botId: bot.id, path: MEMORY_INDEX_PATH },
    },
    select: { id: true },
  });
  return Boolean(revision);
}

async function settleByRevision(prisma: Db, bot: Bot, tag: string) {
  await settleLearningWrite(prisma, tag, await learningWriteLanded(prisma, bot, tag));
}

/**
 * Settles the bot's writes a crash left pending: with `reviews` (only the review holding the bot's
 * lease asks) every review's, and any write pending past LEARNING_WRITE_SETTLE_MS.
 */
export async function settleLeftLearningWrites(prisma: Db, bot: Bot, reviews: boolean) {
  const tags = await pendingLearningWrites(prisma, bot.id, {
    reviews,
    olderThanMs: LEARNING_WRITE_SETTLE_MS,
  });
  for (const tag of tags) await settleByRevision(prisma, bot, tag);
}

/**
 * Writes the notes under `tag`, after the changes it makes were recorded as pending, and settles
 * them by the outcome: a write that failed may still have landed, which its revision tells.
 */
async function commitTagged(
  deps: { prisma: Db; memory: DozoLearningMemory },
  bot: Bot,
  context: AdapterContext,
  write: { content: string; revision: number },
  tag: string,
) {
  try {
    await deps.memory.commit(
      {
        scope: "bot",
        botId: bot.id,
        path: MEMORY_INDEX_PATH,
        content: write.content,
        expectedRevision: write.revision,
        sourceRunId: tag,
      },
      context,
    );
  } catch (error) {
    // Left pending when this fails too: the next review or settle job reads the revision.
    await bestEffort("settle a learning write", settleByRevision(deps.prisma, bot, tag));
    throw error;
  }
}

/**
 * Applies a review's answer to the notes as they are now. Its changes are recorded as pending
 * before the notes are written and settled after, so a learned line is always listed; reading
 * again when another write got in first.
 */
export function saveLearnedNotes(
  deps: { prisma: Db; memory: DozoLearningMemory },
  bot: Bot,
  context: AdapterContext,
  answer: {
    ops: LearningOp[];
    labels: ReadonlyMap<string, string>;
    rejected: ReadonlySet<string>;
    source: { threadId: string | null; messageId: string | null };
  },
): Promise<LearningChangeInput[]> {
  return retry(
    async () => {
      const notes = await readNotes(deps.memory, bot.id, context);
      const edit = applyLearningOps(notes.content, answer.ops, answer.labels, answer.rejected);
      if (!edit.applied.length) return [];
      const tag = newWriteTag();
      await saveLearningChanges(deps.prisma, bot, answer.source, edit.applied, tag);
      await commitTagged(
        deps,
        bot,
        context,
        { content: edit.content, revision: notes.revision },
        tag,
      );
      await settleLearningWrite(deps.prisma, tag, true);
      return edit.applied;
    },
    { attempts: MEMORY_SAVE_ATTEMPTS, retryable: overtaken, delayMs: 0 },
  );
}

/** The owner edited the line since: undoing would overwrite their words. */
export class DozoLearningChangedError extends ClientError {
  constructor() {
    super("CONFLICT", "This note was changed since it was learned.", DOZO_LEARNING_CHANGED_CODE);
  }
}

/** The job that settles an undo cut short, should its process stop. */
export function learningSettleJob(botId: string, availableAt: Date): BackgroundJob {
  return {
    name: "memory.learning-review",
    payload: { botId, settleOnly: true },
    availableAt,
    replaceKey: `learning.settle:${botId}`,
  };
}

/**
 * Undoes one change of the caller's Space and marks it undone. The undo is recorded as pending
 * (with a job to settle it should this process stop) before the notes are written. A put-back
 * line may take the notes past their cap, as an owner's edit may. Undoing twice changes nothing
 * more; a change whose write is under way is answered as it is.
 */
export async function undoLearningChange(
  deps: {
    prisma: Db;
    memory: DozoLearningMemory;
    jobs: Pick<JobPublisher, "enqueueIn">;
    events?: LearningEvents;
  },
  actor: { spaceId: string; userId: string },
  changeId: string,
  checkBot: (botId: string) => Promise<unknown>,
): Promise<DozoLearningChange> {
  const found = await findLearningChange(deps.prisma, actor.spaceId, changeId);
  if (!found) throw new ClientError("NOT_FOUND", "This change no longer exists.");
  await checkBot(found.botId);
  const bot = { id: found.botId, spaceId: actor.spaceId };
  let change = found;
  if (found.pending) {
    // A write of it a crash cut short is settled first.
    await settleLeftLearningWrites(deps.prisma, bot, false);
    change = (await findLearningChange(deps.prisma, actor.spaceId, changeId)) ?? found;
  }
  const { botId: _botId, supersededBy, ownerEdited, pending, ...shown } = change;
  if (change.undoneAt) return shown;
  // A later change or the owner took its line over: the line is theirs.
  if (supersededBy || ownerEdited) throw new DozoLearningChangedError();
  if (pending) return shown;
  const tag = newWriteTag();
  const marked = await deps.prisma.$transaction(async (tx) => {
    if (!(await markLearningUndoPending(tx, changeId, tag))) return false;
    const settleAt = new Date(Date.now() + LEARNING_WRITE_SETTLE_MS + 60_000);
    await deps.jobs.enqueueIn(tx, learningSettleJob(bot.id, settleAt));
    return true;
  });
  if (!marked) return shown;
  const context: AdapterContext = {
    operationId: `learning-undo:${changeId}`,
    traceId: `learning-undo:${changeId}`,
    ...actor,
    botId: bot.id,
    signal: new AbortController().signal,
  };
  try {
    await retry(
      async () => {
        const notes = await readNotes(deps.memory, bot.id, context);
        const next = undoLearningEdit(notes.content, change);
        if (next === null) throw new DozoLearningChangedError();
        if (next === notes.content) return;
        await deps.memory.commit(
          {
            scope: "bot",
            botId: bot.id,
            path: MEMORY_INDEX_PATH,
            content: next,
            expectedRevision: notes.revision,
            sourceRunId: tag,
          },
          context,
        );
      },
      { attempts: MEMORY_SAVE_ATTEMPTS, retryable: overtaken, delayMs: 0 },
    );
  } catch (error) {
    await bestEffort("settle a learning undo", settleByRevision(deps.prisma, bot, tag));
    throw error;
  }
  await settleLearningWrite(deps.prisma, tag, true);
  // Only the bot's owner undoes (checkBot): theirs is the topic.
  await learningChanged(deps.events, actor.userId);
  return { ...shown, undoneAt: new Date().toISOString() };
}

/**
 * After the owner saved the bot's MEMORY.md in the memory panel: every learned line they changed
 * or removed there (fewer lines read as it than before) becomes theirs, so no review edits it
 * again or writes it back. Never fails the save.
 */
export async function dozoOwnerEditedNotes(
  prisma: Db,
  document: { scope: string; path: string; botId: string | null; content: string },
  saved: string,
): Promise<void> {
  const { botId } = document;
  if (document.scope !== "bot" || document.path !== MEMORY_INDEX_PATH || !botId) return;
  await bestEffort(
    "mark learned lines the owner edited",
    (async () => {
      const before = linesOf(document.content);
      const after = linesOf(saved);
      const lost = (await learnedLines(prisma, botId)).filter(
        (learned) => countOf(after, learned.after) < countOf(before, learned.after),
      );
      await markLearningLinesOwnerEdited(
        prisma,
        lost.map((learned) => learned.id),
      );
    })(),
  );
}
