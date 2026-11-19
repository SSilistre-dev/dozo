import type { TeachRecordingEvent, TeachTypedValue } from "@rakazo/core";
import {
  clicksBeforeSecrets,
  scrubTeachRecordingEvents,
  teachWindowApp,
  typedValuesFromRecording,
} from "@rakazo/core";
import { z } from "zod";
import type { Prisma, PrismaClient } from "./client.js";
import { ciphertextKeyId, decryptText, encryptText } from "./content-crypto.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { storedTeachTargets, TEACH_TARGETS_KEY } from "./dozo-teaching-recordings.js";
import { readJsonColumn } from "./json-column.js";

export { storedTeachTargets, TEACH_TARGETS_KEY } from "./dozo-teaching-recordings.js";

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

/** The picture around a recorded click, by its event in the drafted recording (base64 WebP). */
export type TeachClickImage = { eventIndex: number; image: string };

export type StoredTeachValues = {
  /** The person who taught the skill: the only one who may see the values. */
  userId: string;
  values: TeachTypedValue[];
  /** The pictures of the clicks, none of a click before protected input. */
  images: TeachClickImage[];
  /** Null until the model was asked; an empty record when it gave nothing. */
  suggestions: TeachValueSuggestions | null;
};

const ValuesSchema = z.array(
  z.object({ placeholder: z.string(), text: z.string().nullable(), secret: z.boolean() }),
);
const ImagesSchema = z.array(
  z.object({ eventIndex: z.number().int().nonnegative(), image: z.string() }),
);
const SuggestionsSchema = z.record(z.string(), z.object({ name: z.string() })).nullable();

type Db = Prisma.TransactionClient | PrismaClient;
type Row = {
  skillId: string;
  spaceId: string;
  userId: string;
  values: string;
  targets: string | null;
  suggestions: unknown;
};

type Column = "values" | "targets";

function locationOf(row: { skillId: string; userId: string }, column: Column) {
  return { table: TABLE, column, rowId: row.skillId, owner: row.userId };
}

/** Sealed with the Space's content key, as user content is; plain only where encryption is off. */
async function seal(
  db: Db,
  row: { skillId: string; spaceId: string; userId: string },
  column: Column,
  text: string,
) {
  const ring = contentEncryptionOf(db)?.ring;
  if (!ring?.encryptWrites) return text;
  return encryptText(await ring.current(row.spaceId), locationOf(row, column), text);
}

async function open(db: Db, row: Row, column: Column, text: string): Promise<unknown> {
  const keyId = ciphertextKeyId(text);
  if (keyId) {
    const ring = contentEncryptionOf(db)?.ring;
    if (!ring) throw new Error("Teach values encryption is unavailable");
    const key = await ring.byId(keyId);
    if (key.spaceId !== row.spaceId) throw new Error("Teach values space mismatch");
    return JSON.parse(decryptText(key, locationOf(row, column), text));
  }
  return JSON.parse(text);
}

async function decode(db: Db, row: Row): Promise<StoredTeachValues> {
  const at = { table: TABLE, id: row.skillId };
  return {
    userId: row.userId,
    values: readJsonColumn(
      ValuesSchema,
      await open(db, row, "values", row.values),
      { ...at, column: "values" },
      "reject",
    ),
    images: row.targets
      ? readJsonColumn(
          ImagesSchema,
          await open(db, row, "targets", row.targets),
          { ...at, column: "targets" },
          // A click without its picture only keeps its window and coordinate.
          { fallback: [] },
        )
      : [],
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
 * transaction: the values typed and the pictures around the clicks move to a short-lived store
 * only the teacher reads, and the recording keeps none of them, not even the values' length or
 * timing (each click keeps its window's application name). A click before protected input loses
 * its picture. Due in 24 hours, on a queue job when the queue's tables exist; reads also skip and
 * delete a due row.
 */
export async function keepTeachValues<R extends { events: TeachRecordingEvent[] }>(
  tx: Prisma.TransactionClient,
  skill: { id: string; spaceId: string; userId: string },
  recording: R,
): Promise<
  Omit<R, "dozoSuggestions" | typeof TEACH_TARGETS_KEY> & {
    [TEACH_TARGETS_KEY]?: Array<{ eventIndex: number; window?: string }>;
  }
> {
  // Suggestions an older draft cached in its recording go with the values.
  const {
    dozoSuggestions: _cached,
    [TEACH_TARGETS_KEY]: _targets,
    ...kept
  } = recording as R & { dozoSuggestions?: unknown; [TEACH_TARGETS_KEY]?: unknown };
  const values = typedValuesFromRecording(recording.events);
  const { events, indexOf } = scrubTeachRecordingEvents(recording.events);
  const secret = clicksBeforeSecrets(recording.events);
  const targets: Array<{ eventIndex: number; window?: string }> = [];
  const images: TeachClickImage[] = [];
  for (const target of storedTeachTargets(skill.id, recording)) {
    const eventIndex = indexOf.get(target.eventIndex);
    if (eventIndex === undefined) continue;
    // Only the application's name: the rest of a title can show what was typed.
    const window = teachWindowApp(target.window);
    targets.push({ eventIndex, ...(window ? { window } : {}) });
    if (target.image && !secret.has(target.eventIndex)) {
      images.push({ eventIndex, image: target.image });
    }
  }
  if (values.length || images.length) {
    const row = { skillId: skill.id, spaceId: skill.spaceId, userId: skill.userId };
    const sealed = await seal(tx, row, "values", JSON.stringify(values));
    const pictures = images.length ? await seal(tx, row, "targets", JSON.stringify(images)) : null;
    const [stored] = await tx.$queryRaw<Array<{ expiresAt: Date }>>`
      INSERT INTO "dozo_teach_values"
        ("skillId", "spaceId", "userId", "values", "targets", "expiresAt")
      VALUES (${row.skillId}, ${row.spaceId}, ${row.userId}, ${sealed}, ${pictures},
        CURRENT_TIMESTAMP + make_interval(secs => ${TEACH_VALUES_TTL_MS / 1000}))
      ON CONFLICT ("skillId") DO UPDATE SET "spaceId" = EXCLUDED."spaceId",
        "userId" = EXCLUDED."userId", "values" = EXCLUDED."values",
        "targets" = EXCLUDED."targets", "suggestions" = NULL,
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
  return { ...kept, events, ...(targets.length ? { [TEACH_TARGETS_KEY]: targets } : {}) };
}

/** The values of a draft, or null once they are saved, removed or due (a due row is deleted). */
export async function readTeachValues(db: Db, skillId: string): Promise<StoredTeachValues | null> {
  await expireTeachValues(db, skillId);
  const [row] = await db.$queryRaw<Row[]>`
    SELECT "skillId", "spaceId", "userId", "values", "targets", "suggestions"
    FROM "dozo_teach_values"
    WHERE "skillId" = ${skillId}`;
  return row ? decode(db, row) : null;
}

/** Deletes the values in the caller's transaction (the save's) and returns them unless due. */
export async function takeTeachValues(
  tx: Prisma.TransactionClient,
  skillId: string,
): Promise<StoredTeachValues | null> {
  const [row] = await tx.$queryRaw<Array<Row & { due: boolean }>>`
    DELETE FROM "dozo_teach_values" WHERE "skillId" = ${skillId}
    RETURNING "skillId", "spaceId", "userId", "values", "targets", "suggestions",
      "expiresAt" <= CURRENT_TIMESTAMP AS "due"`;
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
