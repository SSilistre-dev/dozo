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
  /** The review may read the bot's reply; false or null (unknown): only the owner's words. */
  botReplyReadable: boolean | null;
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
  if (mode === "off") await dropLearningTurns(db, bot.id);
}

/** Drops every turn waiting for the bot's review: nothing is learned from them. */
export async function dropLearningTurns(db: Db, botId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM dozo_learning_turns WHERE "botId" = ${botId}`;
}

/**
 * The newest turns kept per bot while no review reads them (no usable model, a review that keeps
 * failing); a review reads at most as many.
 */
export const LEARNING_TURNS_KEPT = 100;

/**
 * Records one turn (a run's completion can repeat: its run records it once), drops the bot's
 * turns past the newest kept, and answers how many now wait for a review. The caller runs it in
 * one transaction.
 */
export async function recordLearningTurn(
  db: Db,
  turn: Omit<LearningTurn, "id" | "botReplyReadable"> & {
    botId: string;
    spaceId: string;
    botReplyReadable: boolean;
  },
): Promise<number> {
  await db.$executeRaw`
    INSERT INTO dozo_learning_turns
      (id, "botId", "spaceId", "threadId", "runId", "messageId", "botReplyReadable")
    VALUES (${randomUUID()}, ${turn.botId}, ${turn.spaceId}, ${turn.threadId}, ${turn.runId},
      ${turn.messageId}, ${turn.botReplyReadable})
    ON CONFLICT ("runId") DO NOTHING`;
  await db.$executeRaw`
    DELETE FROM dozo_learning_turns WHERE "botId" = ${turn.botId} AND id NOT IN (
      SELECT id FROM dozo_learning_turns WHERE "botId" = ${turn.botId}
      ORDER BY "createdAt" DESC, id DESC LIMIT ${LEARNING_TURNS_KEPT})`;
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
    SELECT id, "threadId", "runId", "messageId", "botReplyReadable" FROM (
      SELECT id, "threadId", "runId", "messageId", "botReplyReadable", "createdAt"
      FROM dozo_learning_turns
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

/** How many reviews one bot may ask a model in a day. */
export const LEARNING_REVIEWS_PER_DAY = 6;

/**
 * Takes one of the bot's reviews of the last day, or answers false when it used them all. Run by
 * the review holding the bot's lease, so two never count at once.
 */
export async function takeLearningReview(
  db: Db,
  bot: { id: string; spaceId: string },
): Promise<boolean> {
  await db.$executeRaw`
    DELETE FROM dozo_learning_reviews
    WHERE "botId" = ${bot.id} AND "createdAt" <= CURRENT_TIMESTAMP - interval '1 day'`;
  const [row] = await db.$queryRaw<Array<{ used: number }>>`
    SELECT count(*)::int AS used FROM dozo_learning_reviews WHERE "botId" = ${bot.id}`;
  if ((row?.used ?? 0) >= LEARNING_REVIEWS_PER_DAY) return false;
  await db.$executeRaw`
    INSERT INTO dozo_learning_reviews (id, "botId", "spaceId", "createdAt")
    VALUES (${randomUUID()}, ${bot.id}, ${bot.spaceId}, CURRENT_TIMESTAMP)`;
  return true;
}

/**
 * The review's own lines: changes that set a line, not undone, not taken over by a later change
 * and not edited by the owner, newest first.
 */
export async function learnedLines(db: Db, botId: string): Promise<LearnedLine[]> {
  return db.$queryRaw<LearnedLine[]>`
    SELECT id, "after" FROM dozo_learning_changes
    WHERE "botId" = ${botId} AND "undoneAt" IS NULL AND "supersededBy" IS NULL
      AND "ownerEditedAt" IS NULL AND kind IN ('add', 'update')
    ORDER BY "createdAt" DESC, id DESC LIMIT ${CHANGES_KEPT}`;
}

/**
 * Lines the owner turned down, newest first: a learned line they undid, or changed or removed
 * in the memory panel. A review is not to write them again.
 */
export async function rejectedLearningLines(db: Db, botId: string): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ after: string }>>`
    SELECT "after" FROM dozo_learning_changes
    WHERE "botId" = ${botId} AND kind IN ('add', 'update')
      AND ("undoneAt" IS NOT NULL OR "ownerEditedAt" IS NOT NULL)
    ORDER BY COALESCE("undoneAt", "ownerEditedAt") DESC, id DESC LIMIT ${CHANGES_KEPT}`;
  return rows.map((row) => row.after);
}

/**
 * Marks as the owner's the changes (by id) whose line the owner changed or removed in the memory
 * panel, so no review edits that line again or writes it back.
 */
export async function markLearningLinesOwnerEdited(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.$executeRaw`
    UPDATE dozo_learning_changes SET "ownerEditedAt" = CURRENT_TIMESTAMP
    WHERE id = ANY(${ids}::text[]) AND "ownerEditedAt" IS NULL`;
}

export type LearningChangeInput = {
  kind: "add" | "update" | "remove";
  before: string | null;
  after: string | null;
};

/**
 * Records what one review changed, in order, as pending under `tag` until its write of the
 * notes is settled, and forgets changes past the newest kept. A change takes over from every live
 * older change whose line it replaced or wrote again.
 */
export async function saveLearningChanges(
  db: Db,
  bot: { id: string; spaceId: string },
  source: { threadId: string | null; messageId: string | null },
  changes: LearningChangeInput[],
  tag: string,
): Promise<void> {
  const at = Date.now();
  for (const [index, change] of changes.entries()) {
    // One review's changes are listed in the order they were made.
    const createdAt = new Date(at + index).toISOString();
    const id = randomUUID();
    await db.$executeRaw`
      INSERT INTO dozo_learning_changes
        (id, "botId", "spaceId", "threadId", "messageId", kind, "before", "after", "createdAt",
         pending, "pendingTag", "pendingSince")
      VALUES (${id}, ${bot.id}, ${bot.spaceId}, ${source.threadId}, ${source.messageId},
        ${change.kind}, ${change.before}, ${change.after}, ${createdAt}::timestamptz,
        'apply', ${tag}, CURRENT_TIMESTAMP)`;
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

/** Marks one change's undo as under way under `tag`; false when it is undone or already pending. */
export async function markLearningUndoPending(
  db: Db,
  changeId: string,
  tag: string,
): Promise<boolean> {
  const marked = await db.$executeRaw`
    UPDATE dozo_learning_changes
    SET pending = 'undo', "pendingTag" = ${tag}, "pendingSince" = CURRENT_TIMESTAMP
    WHERE id = ${changeId} AND "undoneAt" IS NULL AND pending IS NULL`;
  return marked === 1;
}

/**
 * Settles the changes of one write of the notes. Landed: a review's changes stop being pending,
 * an undo marks its change undone and hands the lines it took over back to the changes it took
 * them from. Not landed: a review's changes are deleted (and the lines they took over handed
 * back), an undo stops being pending.
 */
export async function settleLearningWrite(db: Db, tag: string, landed: boolean): Promise<void> {
  if (landed) {
    const undone = await db.$queryRaw<Array<{ id: string }>>`
      UPDATE dozo_learning_changes SET "undoneAt" = CURRENT_TIMESTAMP
      WHERE "pendingTag" = ${tag} AND pending = 'undo' AND "undoneAt" IS NULL RETURNING id`;
    for (const { id } of undone)
      await db.$executeRaw`
        UPDATE dozo_learning_changes SET "supersededBy" = NULL WHERE "supersededBy" = ${id}`;
    await db.$executeRaw`
      UPDATE dozo_learning_changes SET pending = NULL, "pendingTag" = NULL, "pendingSince" = NULL
      WHERE "pendingTag" = ${tag}`;
    return;
  }
  const dropped = await db.$queryRaw<Array<{ id: string }>>`
    DELETE FROM dozo_learning_changes WHERE "pendingTag" = ${tag} AND pending = 'apply'
    RETURNING id`;
  const ids = dropped.map((row) => row.id);
  if (ids.length)
    await db.$executeRaw`
      UPDATE dozo_learning_changes SET "supersededBy" = NULL
      WHERE "supersededBy" = ANY(${ids}::text[])`;
  await db.$executeRaw`
    UPDATE dozo_learning_changes SET pending = NULL, "pendingTag" = NULL, "pendingSince" = NULL
    WHERE "pendingTag" = ${tag}`;
}

/**
 * Tags of the bot's writes left pending: with `reviews`, every one of a review (only the review
 * holding the bot's lease asks, so none of them is under way), and any pending longer than
 * `olderThanMs`, which no write takes.
 */
export async function pendingLearningWrites(
  db: Db,
  botId: string,
  options: { reviews: boolean; olderThanMs: number },
): Promise<string[]> {
  const seconds = options.olderThanMs / 1000;
  const rows = await db.$queryRaw<Array<{ tag: string }>>`
    SELECT DISTINCT "pendingTag" AS tag FROM dozo_learning_changes
    WHERE "botId" = ${botId} AND "pendingTag" IS NOT NULL
      AND ((${options.reviews} AND pending = 'apply')
        OR "pendingSince" <= CURRENT_TIMESTAMP - ${seconds}::float8 * interval '1 second')`;
  return rows.map((row) => row.tag);
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
  ownerEditedAt?: Date | null;
  pending?: "apply" | "undo" | null;
};

const toChange = ({
  botId: _botId,
  supersededBy: _supersededBy,
  ownerEditedAt: _ownerEditedAt,
  pending: _pending,
  ...row
}: ChangeRow): DozoLearningChange => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  undoneAt: row.undoneAt?.toISOString() ?? null,
});

/** The bot's latest changes, newest first, a pending one included. */
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

/** A change as an undo reads it: with its bot, and whatever makes its line no longer its own. */
export type FoundLearningChange = DozoLearningChange & {
  botId: string;
  supersededBy: string | null;
  ownerEdited: boolean;
  pending: "apply" | "undo" | null;
};

/** One change of the Space. */
export async function findLearningChange(
  db: Db,
  spaceId: string,
  changeId: string,
): Promise<FoundLearningChange | undefined> {
  const [row] = await db.$queryRaw<ChangeRow[]>`
    SELECT id, "botId", kind, "before", "after", "supersededBy", pending,
      "createdAt" AT TIME ZONE 'UTC' AS "createdAt", "undoneAt" AT TIME ZONE 'UTC' AS "undoneAt",
      "ownerEditedAt" AT TIME ZONE 'UTC' AS "ownerEditedAt"
    FROM dozo_learning_changes WHERE id = ${changeId} AND "spaceId" = ${spaceId}`;
  return (
    row && {
      ...toChange(row),
      botId: row.botId,
      supersededBy: row.supersededBy ?? null,
      ownerEdited: Boolean(row.ownerEditedAt),
      pending: row.pending ?? null,
    }
  );
}
