import type { TeachRecordingEvent, TeachSnapshot, TeachTypedValue } from "@rakazo/core";
import { forgetTeachTyping, typedValuesFromRecording } from "@rakazo/core";
import { z } from "zod";
import type { Prisma, PrismaClient } from "./client.js";
import { ciphertextKeyId, decryptText, encryptText } from "./content-crypto.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { readJsonColumn } from "./json-column.js";
import { runAsSystemInTransaction } from "./row-security.js";

/** How long the teacher has to review what was typed before it is forgotten. */
export const TEACH_VALUES_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The queue's job for a skill's teaching timer; its handler also forgets the skill's values once
 * they are due. Its own key, so it never replaces the recording's timer.
 */
const EXPIRE_JOB = "skill.teaching-expire";
const expireJobKey = (skillId: string) => `dozo.teach-values:${skillId}`;

const TABLE = "dozo_teach_values";

/** A name the model suggested for each placeholder, cached so it is asked once per draft. */
export type TeachValueSuggestions = Record<string, { name: string }>;

export type StoredTeachValues = {
  /** The person who taught the skill: the only one who may see the values. */
  userId: string;
  values: TeachTypedValue[];
  /** Null until the model was asked; an empty record when it gave nothing. */
  suggestions: TeachValueSuggestions | null;
};

const ValuesSchema = z.array(
  z.object({ placeholder: z.string(), text: z.string().nullable(), secret: z.boolean() }),
);
const SuggestionsSchema = z.record(z.string(), z.object({ name: z.string() })).nullable();

type Db = Prisma.TransactionClient | PrismaClient;
type Row = {
  skillId: string;
  spaceId: string;
  userId: string;
  values: string;
  suggestions: unknown;
};

function locationOf(row: { skillId: string; userId: string }) {
  return { table: TABLE, column: "values", rowId: row.skillId, owner: row.userId };
}

/** Sealed with the Space's content key, as user content is; plain only where encryption is off. */
async function seal(
  db: Db,
  row: { skillId: string; spaceId: string; userId: string },
  text: string,
) {
  const ring = contentEncryptionOf(db)?.ring;
  if (!ring?.encryptWrites) return text;
  return encryptText(await ring.current(row.spaceId), locationOf(row), text);
}

async function decode(db: Db, row: Row): Promise<StoredTeachValues> {
  let text = row.values;
  const keyId = ciphertextKeyId(text);
  if (keyId) {
    const ring = contentEncryptionOf(db)?.ring;
    if (!ring) throw new Error("Teach values encryption is unavailable");
    const key = await ring.byId(keyId);
    if (key.spaceId !== row.spaceId) throw new Error("Teach values space mismatch");
    text = decryptText(key, locationOf(row), text);
  }
  const at = { table: TABLE, id: row.skillId };
  return {
    userId: row.userId,
    values: readJsonColumn(ValuesSchema, JSON.parse(text), { ...at, column: "values" }, "reject"),
    suggestions: readJsonColumn(
      SuggestionsSchema,
      row.suggestions,
      { ...at, column: "suggestions" },
      // Asked again, never shown as what the model said.
      { fallback: null },
    ),
  };
}

/**
 * Called where a recording becomes a draft (stop, expiry, the end of its control), in that
 * transaction: the values typed move to a short-lived store only the teacher reads, and the
 * recording keeps none of them, not even their length or timing, and of each window title only
 * its application. Due in 24 hours, on a queue job when the queue's tables exist; reads, and the
 * API's slow sweep, also delete a due row. Written past row security: whoever ends the recording
 * (another member taking the computer's control) stores them for the teacher, who alone reads
 * them.
 */
export async function keepTeachValues<
  R extends { events: TeachRecordingEvent[]; snapshots: TeachSnapshot[] },
>(
  tx: Prisma.TransactionClient,
  skill: { id: string; spaceId: string; userId: string },
  recording: R,
) {
  const values = typedValuesFromRecording(recording.events);
  if (values.length) {
    await runAsSystemInTransaction(tx, "keep the values typed while teaching", () =>
      storeValues(tx, skill, values),
    );
  }
  return forgetTeachTyping(recording);
}

async function storeValues(
  tx: Prisma.TransactionClient,
  skill: { id: string; spaceId: string; userId: string },
  values: TeachTypedValue[],
) {
  const row = { skillId: skill.id, spaceId: skill.spaceId, userId: skill.userId };
  const sealed = await seal(tx, row, JSON.stringify(values));
  const [stored] = await tx.$queryRaw<Array<{ expiresAt: Date }>>`
    INSERT INTO "dozo_teach_values" ("skillId", "spaceId", "userId", "values", "expiresAt")
    VALUES (${row.skillId}, ${row.spaceId}, ${row.userId}, ${sealed},
      CURRENT_TIMESTAMP + make_interval(secs => ${TEACH_VALUES_TTL_MS / 1000}))
    ON CONFLICT ("skillId") DO UPDATE SET "spaceId" = EXCLUDED."spaceId",
      "userId" = EXCLUDED."userId", "values" = EXCLUDED."values", "suggestions" = NULL,
      "expiresAt" = EXCLUDED."expiresAt"
    RETURNING "expiresAt"`;
  const [queue] = await tx.$queryRaw<Array<{ ready: boolean }>>`
    SELECT to_regnamespace('graphile_worker') IS NOT NULL AS ready`;
  if (stored && queue?.ready) {
    // As upstream's publisher adds a job in a transaction; the date goes as text with its zone.
    await tx.$executeRaw`
      SELECT graphile_worker.add_job(${EXPIRE_JOB}::text,
        ${JSON.stringify({ skillId: skill.id })}::json,
        run_at => ${stored.expiresAt.toISOString()}::timestamptz,
        job_key => ${expireJobKey(skill.id)}::text)`;
  }
}

/** The values of a draft, or null once they are saved, removed or due (a due row is deleted). */
export async function readTeachValues(db: Db, skillId: string): Promise<StoredTeachValues | null> {
  await expireTeachValues(db, skillId);
  const [row] = await db.$queryRaw<Row[]>`
    SELECT "skillId", "spaceId", "userId", "values", "suggestions" FROM "dozo_teach_values"
    WHERE "skillId" = ${skillId}`;
  return row ? decode(db, row) : null;
}

/** Deletes the values in the caller's transaction (the save's) and returns them unless due. */
export async function takeTeachValues(
  tx: Prisma.TransactionClient,
  skillId: string,
): Promise<StoredTeachValues | null> {
  // Past row security: any save forgets them, also one by someone else than the teacher.
  const [row] = await runAsSystemInTransaction(
    tx,
    "forget the values typed while teaching",
    () =>
      tx.$queryRaw<Array<Row & { due: boolean }>>`
      DELETE FROM "dozo_teach_values" WHERE "skillId" = ${skillId}
      RETURNING "skillId", "spaceId", "userId", "values", "suggestions",
        "expiresAt" <= CURRENT_TIMESTAMP AS "due"`,
  );
  return row && !row.due ? decode(tx, row) : null;
}

/**
 * Keeps the first suggestions written for a draft, so two reviews at once agree. Null when the
 * values are gone meanwhile.
 */
export async function cacheTeachSuggestions(
  db: Db,
  skillId: string,
  suggestions: TeachValueSuggestions,
): Promise<TeachValueSuggestions | null> {
  const [row] = await db.$queryRaw<Array<{ suggestions: unknown }>>`
    UPDATE "dozo_teach_values"
    SET "suggestions" = COALESCE("suggestions", ${JSON.stringify(suggestions)}::jsonb)
    WHERE "skillId" = ${skillId} AND "expiresAt" > CURRENT_TIMESTAMP
    RETURNING "suggestions"`;
  if (!row) return null;
  return readJsonColumn(
    SuggestionsSchema,
    row.suggestions,
    { table: TABLE, column: "suggestions", id: skillId },
    { fallback: suggestions },
  );
}

/** Forgets a skill's values once they are due; the queue's job and every read call it. */
export async function expireTeachValues(db: Db, skillId: string): Promise<void> {
  await db.$executeRaw`
    DELETE FROM "dozo_teach_values"
    WHERE "skillId" = ${skillId} AND "expiresAt" <= CURRENT_TIMESTAMP`;
}

/** Forgets every due row; the API's slow sweep calls it, as system, also where no queue runs. */
export async function expireAllTeachValues(db: Db): Promise<number> {
  return db.$executeRaw`
    DELETE FROM "dozo_teach_values" WHERE "expiresAt" <= CURRENT_TIMESTAMP`;
}
