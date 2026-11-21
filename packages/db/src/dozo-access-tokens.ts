import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw"> | Prisma.TransactionClient;

type Member = { userId: string; spaceId: string };

/** Every token starts with this, so a scanner can find one pasted where it should not be. */
export const DOZO_ACCESS_TOKEN_PREFIX = "dozo_pat_";

/**
 * A token works until it expires, and only if its account's password has not changed since it was
 * made: a password change or reset revokes every token, so a session taken over cannot leave one
 * behind that outlives the new password.
 */
const STILL_VALID = Prisma.sql`(t."expiresAt" IS NULL OR t."expiresAt" > now())
  AND NOT EXISTS (SELECT 1 FROM security_events s
    WHERE s."userId" = t."userId" AND s.type = 'auth.password.changed'
      AND s."createdAt" AT TIME ZONE 'UTC' >= t."createdAt")`;

/**
 * A time as UTC text for a `timestamptz` column. A raw query sends a Date without its zone, which
 * the database would read in its own session zone, as the person's machine may set it.
 */
function utc<T extends Date | null>(date: T): T extends Date ? string : null {
  return (date ? date.toISOString() : null) as T extends Date ? string : null;
}

/** How many tokens one member may hold in one Space. */
export const DOZO_ACCESS_TOKEN_LIMIT = 20;

/** A token is not marked used more often than this, so a busy script does not write every call. */
const TOUCH_INTERVAL_MS = 60_000;

export type DozoAccessTokenRow = {
  id: string;
  name: string;
  botId: string | null;
  botName: string | null;
  hint: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
};

/** A token as the API reads it before it knows who is calling. */
export type DozoAccessTokenOwner = {
  id: string;
  userId: string;
  spaceId: string;
  botId: string | null;
  email: string;
  deactivated: boolean;
};

/** The hash a token is stored and found under. The token itself is never stored. */
export function dozoAccessTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Whether a string has the shape of a token, checked before anything is looked up. */
export function looksLikeDozoAccessToken(value: string): boolean {
  return /^dozo_pat_[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * Makes a token for the member in the Space, for one bot or all of them, and returns it once with
 * its row. Returns null when the member already holds the most tokens allowed.
 */
export async function createDozoAccessToken(
  db: Db,
  member: Member,
  input: { name: string; botId: string | null; expiresAt: Date | null },
): Promise<{ token: string; row: DozoAccessTokenRow } | null> {
  const token = `${DOZO_ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const hint = token.slice(-4);
  const rows = await db.$queryRaw<{ id: string; createdAt: Date }[]>`
    INSERT INTO dozo_access_tokens ("userId", "spaceId", "botId", name, "tokenHash", hint, "expiresAt")
    SELECT ${member.userId}, ${member.spaceId}, ${input.botId}, ${input.name},
      ${dozoAccessTokenHash(token)}, ${hint}, ${utc(input.expiresAt)}::timestamptz
    WHERE (SELECT count(*) FROM dozo_access_tokens
      WHERE "userId" = ${member.userId} AND "spaceId" = ${member.spaceId})
      < ${DOZO_ACCESS_TOKEN_LIMIT}
    RETURNING id, "createdAt"`;
  const created = rows[0];
  if (!created) return null;
  return {
    token,
    row: {
      id: created.id,
      name: input.name,
      botId: input.botId,
      botName: null,
      hint,
      createdAt: created.createdAt,
      lastUsedAt: null,
      expiresAt: input.expiresAt,
    },
  };
}

/** The member's tokens in one Space, newest first, with the name of the bot each is limited to. */
export function listDozoAccessTokens(db: Db, member: Member): Promise<DozoAccessTokenRow[]> {
  return db.$queryRaw<DozoAccessTokenRow[]>`
    SELECT t.id, t.name, t."botId", b.name AS "botName", t.hint, t."createdAt", t."lastUsedAt",
      t."expiresAt"
    FROM dozo_access_tokens t LEFT JOIN bots b ON b.id = t."botId"
    WHERE t."userId" = ${member.userId} AND t."spaceId" = ${member.spaceId} AND ${STILL_VALID}
    ORDER BY t."createdAt" DESC, t.id DESC`;
}

/** Deletes one of the member's tokens in the Space; another member's id deletes nothing. */
export async function revokeDozoAccessToken(db: Db, member: Member, id: string): Promise<boolean> {
  const count = await db.$executeRaw`
    DELETE FROM dozo_access_tokens
    WHERE id = ${id} AND "userId" = ${member.userId} AND "spaceId" = ${member.spaceId}`;
  return count > 0;
}

/**
 * The token's owner, Space and bot by the token's hash, or null. Run it as the system: the caller
 * is not known yet. A token of a Space the member left is gone with the membership.
 */
export async function findDozoAccessToken(
  db: Db,
  token: string,
): Promise<DozoAccessTokenOwner | null> {
  const rows = await db.$queryRaw<DozoAccessTokenOwner[]>`
    SELECT t.id, t."userId", t."spaceId", t."botId", u.email,
      (u."deactivatedAt" IS NOT NULL) AS deactivated
    FROM dozo_access_tokens t JOIN "user" u ON u.id = t."userId"
    WHERE t."tokenHash" = ${dozoAccessTokenHash(token)} AND ${STILL_VALID}
    LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Counts one more for `key` in the current minute, in Postgres so every API instance shares it,
 * and says whether it stays within `limit`. A refused call is not counted. Old minutes go.
 */
export async function takeDozoApiMinute(
  db: Db,
  key: string,
  limit: number,
  now = new Date(),
): Promise<boolean> {
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  await db.$executeRaw`
    DELETE FROM dozo_api_minutes WHERE key = ${key} AND minute < ${utc(minute)}::timestamptz`;
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO dozo_api_minutes (key, minute, count) VALUES (${key}, ${utc(minute)}::timestamptz, 1)
    ON CONFLICT (key, minute) DO UPDATE SET count = dozo_api_minutes.count + 1
      WHERE dozo_api_minutes.count < ${limit}
    RETURNING count`;
  return rows.length > 0;
}

/** Records that the token was used, at most once a minute. */
export async function touchDozoAccessToken(db: Db, id: string, now = new Date()): Promise<void> {
  await db.$executeRaw`
    UPDATE dozo_access_tokens SET "lastUsedAt" = ${utc(now)}::timestamptz
    WHERE id = ${id}
      AND ("lastUsedAt" IS NULL OR "lastUsedAt" < ${utc(new Date(now.getTime() - TOUCH_INTERVAL_MS))}::timestamptz)`;
}
