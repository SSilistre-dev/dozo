import { randomUUID } from "node:crypto";
import type { DozoLearningChange } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

// The fork's learning tables (migration 20270116150000_dozo_bot_learning), read and written with
// SQL: they have no model in schema.prisma. Times are timestamptz, read as UTC.

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

/** What a bot's row holds; a bot without one is `off`. `ask` is a later phase's. */
export type LearningModeValue = "off" | "auto" | "ask";

/** One recorded owner turn no review has read yet. */
export type LearningTurn = {
  id: string;
  threadId: string;
  runId: string;
  messageId: string;
  tainted: boolean;
};

/** A line a review wrote that is still its own: not undone, its line as it left it. */
export type LearnedLine = { id: string; after: string };

/** The newest changes kept per bot; older ones stop counting as the review's own lines. */
const CHANGES_KEPT = 100;

/** One primary-key read: the bot's mode, `off` without a row. */
export async function learningMode(db: Db, botId: string): Promise<LearningModeValue> {
  const rows = await db.$queryRaw<Array<{ mode: LearningModeValue }>>`
    SELECT mode FROM dozo_bot_learning WHERE "botId" = ${botId}`;
  return rows[0]?.mode ?? "off";
}

/** Sets the mode. Off also drops the turns waiting for a review, so nothing is learned from them. */
export async function setLearningMode(
  db: Db,
  bot: { id: string; spaceId: string },
  mode: "off" | "auto",
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO dozo_bot_learning ("botId", "spaceId", mode, "updatedAt")
    VALUES (${bot.id}, ${bot.spaceId}, ${mode}, CURRENT_TIMESTAMP)
    ON CONFLICT ("botId") DO UPDATE SET mode = EXCLUDED.mode, "updatedAt" = CURRENT_TIMESTAMP`;
  if (mode === "off")
    await db.$executeRaw`DELETE FROM dozo_learning_turns WHERE "botId" = ${bot.id}`;
}

/**
 * Records one turn (a run's completion can repeat: its run records it once) and answers how many
 * of the bot's turns now wait for a review.
 */
export async function recordLearningTurn(
  db: Db,
  turn: Omit<LearningTurn, "id"> & { botId: string; spaceId: string },
): Promise<number> {
  await db.$executeRaw`
    INSERT INTO dozo_learning_turns
      (id, "botId", "spaceId", "threadId", "runId", "messageId", tainted)
    VALUES (${randomUUID()}, ${turn.botId}, ${turn.spaceId}, ${turn.threadId}, ${turn.runId},
      ${turn.messageId}, ${turn.tainted})
    ON CONFLICT ("runId") DO NOTHING`;
  const [row] = await db.$queryRaw<Array<{ pending: number }>>`
    SELECT count(*)::int AS pending FROM dozo_learning_turns WHERE "botId" = ${turn.botId}`;
  return row?.pending ?? 0;
}

/** The bot's waiting turns, oldest first: at most `limit`, the newest of them. */
export async function pendingLearningTurns(
  db: Db,
  botId: string,
  limit: number,
): Promise<LearningTurn[]> {
  const rows = await db.$queryRaw<LearningTurn[]>`
    SELECT id, "threadId", "runId", "messageId", tainted FROM (
      SELECT id, "threadId", "runId", "messageId", tainted, "createdAt" FROM dozo_learning_turns
      WHERE "botId" = ${botId} ORDER BY "createdAt" DESC, id DESC LIMIT ${limit}
    ) newest ORDER BY "createdAt", id`;
  return rows;
}

/**
 * Removes the turns a review read, and every older one it left out, so the next review starts
 * after them.
 */
export async function consumeLearningTurns(
  db: Db,
  botId: string,
  turns: LearningTurn[],
): Promise<void> {
  const oldest = turns[0];
  if (!oldest) return;
  const ids = turns.map((turn) => turn.id);
  await db.$executeRaw`
    DELETE FROM dozo_learning_turns WHERE "botId" = ${botId} AND (id = ANY(${ids}::text[])
      OR "createdAt" < (SELECT "createdAt" FROM dozo_learning_turns WHERE id = ${oldest.id}))`;
}

/**
 * The review's own lines: changes that set a line, not undone and not taken over by a later
 * change, newest first.
 */
export async function learnedLines(db: Db, botId: string): Promise<LearnedLine[]> {
  return db.$queryRaw<LearnedLine[]>`
    SELECT id, "after" FROM dozo_learning_changes
    WHERE "botId" = ${botId} AND "undoneAt" IS NULL AND "supersededBy" IS NULL
      AND kind IN ('add', 'update')
    ORDER BY "createdAt" DESC, id DESC LIMIT ${CHANGES_KEPT}`;
}

export type LearningChangeInput = {
  kind: "add" | "update" | "remove";
  before: string | null;
  after: string | null;
};

/**
 * Records what one review changed, in order, and forgets changes past the newest kept. A change
 * takes over from every live older change whose line it replaced or wrote again.
 */
export async function saveLearningChanges(
  db: Db,
  bot: { id: string; spaceId: string },
  threadId: string | null,
  changes: LearningChangeInput[],
): Promise<void> {
  const at = Date.now();
  for (const [index, change] of changes.entries()) {
    // One review's changes are listed in the order they were made.
    const createdAt = new Date(at + index).toISOString();
    const id = randomUUID();
    await db.$executeRaw`
      INSERT INTO dozo_learning_changes
        (id, "botId", "spaceId", "threadId", kind, "before", "after", "createdAt")
      VALUES (${id}, ${bot.id}, ${bot.spaceId}, ${threadId}, ${change.kind},
        ${change.before}, ${change.after}, ${createdAt}::timestamptz)`;
    await db.$executeRaw`
      UPDATE dozo_learning_changes SET "supersededBy" = ${id}
      WHERE id <> ${id} AND "undoneAt" IS NULL AND "supersededBy" IS NULL AND kind <> 'remove'
        AND ("after" = ${change.before} OR "after" = ${change.after}) AND "botId" = ${bot.id}`;
  }
  await db.$executeRaw`
    DELETE FROM dozo_learning_changes WHERE "botId" = ${bot.id} AND id NOT IN (
      SELECT id FROM dozo_learning_changes WHERE "botId" = ${bot.id}
      ORDER BY "createdAt" DESC, id DESC LIMIT ${CHANGES_KEPT})`;
}

type ChangeRow = {
  id: string;
  botId: string;
  kind: DozoLearningChange["kind"];
  before: string | null;
  after: string | null;
  createdAt: Date;
  undoneAt: Date | null;
  supersededBy?: string | null;
};

const toChange = ({
  botId: _botId,
  supersededBy: _supersededBy,
  ...row
}: ChangeRow): DozoLearningChange => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  undoneAt: row.undoneAt?.toISOString() ?? null,
});

/** The bot's latest changes, newest first. */
export async function listLearningChanges(
  db: Db,
  botId: string,
  limit: number,
): Promise<DozoLearningChange[]> {
  const rows = await db.$queryRaw<ChangeRow[]>`
    SELECT id, "botId", kind, "before", "after",
      "createdAt" AT TIME ZONE 'UTC' AS "createdAt", "undoneAt" AT TIME ZONE 'UTC' AS "undoneAt"
    FROM dozo_learning_changes WHERE "botId" = ${botId}
    ORDER BY "createdAt" DESC, id DESC LIMIT ${limit}`;
  return rows.map(toChange);
}

/** One change of the Space, with its bot and the change that took its line over, if any. */
export async function findLearningChange(
  db: Db,
  spaceId: string,
  changeId: string,
): Promise<(DozoLearningChange & { botId: string; supersededBy: string | null }) | undefined> {
  const [row] = await db.$queryRaw<ChangeRow[]>`
    SELECT id, "botId", kind, "before", "after", "supersededBy",
      "createdAt" AT TIME ZONE 'UTC' AS "createdAt", "undoneAt" AT TIME ZONE 'UTC' AS "undoneAt"
    FROM dozo_learning_changes WHERE id = ${changeId} AND "spaceId" = ${spaceId}`;
  return row && { ...toChange(row), botId: row.botId, supersededBy: row.supersededBy ?? null };
}

/**
 * Marks a change undone once; false when it already was. The changes it took lines over from
 * own those lines again, as the undo put them back.
 */
export async function markLearningChangeUndone(db: Db, changeId: string): Promise<boolean> {
  const marked = await db.$executeRaw`
    UPDATE dozo_learning_changes SET "undoneAt" = CURRENT_TIMESTAMP
    WHERE id = ${changeId} AND "undoneAt" IS NULL`;
  if (marked !== 1) return false;
  await db.$executeRaw`
    UPDATE dozo_learning_changes SET "supersededBy" = NULL WHERE "supersededBy" = ${changeId}`;
  return true;
}
