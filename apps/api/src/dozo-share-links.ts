import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Actor, DozoShared, DozoShareLink } from "@rakazo/contracts";
import {
  DOZO_SHARE_LINK_API_PREFIX,
  DOZO_SHARE_LINK_WEB_PREFIX,
  DOZO_SHARE_LINKS_LISTED,
  looksLikeDozoShareToken,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, Prisma, runAsSystem } from "@rakazo/db";
import type { Context, Hono } from "hono";
import { DOZO_SHARE_KINDS } from "./dozo-share-kinds.js";
import { throttleKey, windowCounter } from "./http/window-counter.js";
import type { RouterContext } from "./routes/context.js";

type Db = Pick<PrismaClient, "$queryRaw">;

/** The link a kind's code reads: whose it is and what it points at. */
export type DozoShareTarget = { userId: string; spaceId: string; targetId: string };

/**
 * One kind of link. `canShare` runs as the signed-in maker; `load` runs as the system for a
 * signed-out reader, so it reads only the target it is given and checks the maker still reaches it.
 * Its payload goes to anyone holding the link: put in it only what the link is meant to show.
 */
export interface DozoShareKind {
  canShare(prisma: PrismaClient, actor: Actor, targetId: string): Promise<boolean>;
  /** Null when there is nothing to show any more; the reader gets the same refusal as a bad token. */
  load(prisma: PrismaClient, link: DozoShareTarget): Promise<unknown | null>;
}
export type DozoShareKinds = Readonly<Record<string, DozoShareKind>>;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const READS_PER_IP_PER_MINUTE = 120;
const HEADERS = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};

type Row = {
  id: string;
  kind: string;
  targetId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

function kindOf(kinds: DozoShareKinds, kind: string): DozoShareKind | undefined {
  return Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function linkDto(row: Row): DozoShareLink {
  return {
    id: row.id,
    kind: row.kind,
    targetId: row.targetId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

const COLUMNS = Prisma.sql`"id", "kind", "targetId", "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
  "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt", "revokedAt" AT TIME ZONE 'UTC' AS "revokedAt"`;

/** Makes a link; the token is returned once and only its hash is kept. */
export async function createShareLink(
  prisma: PrismaClient,
  actor: Actor,
  input: { kind: string; targetId: string; days: number },
  kinds: DozoShareKinds = DOZO_SHARE_KINDS,
): Promise<{ link: DozoShareLink; token: string }> {
  const kind = kindOf(kinds, input.kind);
  if (!kind || !(await kind.canShare(prisma, actor, input.targetId))) throw new IsolationError();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + input.days * DAY_MS);
  const [row] = await prisma.$queryRaw<Row[]>`
    INSERT INTO dozo_share_links ("id", "userId", "spaceId", "kind", "targetId", "tokenHash", "expiresAt")
    VALUES (${randomUUID()}, ${actor.userId}, ${actor.spaceId}, ${input.kind}, ${input.targetId},
      ${hashToken(token)}, ${expiresAt.toISOString()}::timestamptz)
    RETURNING ${COLUMNS}`;
  if (!row) throw new Error("share link insert returned no row");
  return { link: linkDto(row), token };
}

/** The member's own links in the Space, newest first, expired and revoked ones included. */
export async function listShareLinks(prisma: Db, actor: Actor): Promise<DozoShareLink[]> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT ${COLUMNS} FROM dozo_share_links
    WHERE "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId}
    ORDER BY "createdAt" DESC, "id" DESC LIMIT ${DOZO_SHARE_LINKS_LISTED}`;
  return rows.map(linkDto);
}

/** Revokes one of the member's links; revoking it again succeeds, anyone else's is not found. */
export async function revokeShareLink(prisma: Db, actor: Actor, id: string): Promise<void> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE dozo_share_links SET "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP)
    WHERE "id" = ${id} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId}
    RETURNING "id"`;
  if (rows.length === 0) throw new IsolationError();
}

/**
 * What a live link shows, or null for every token that does not open one: malformed, unknown,
 * expired, revoked, of a kind this server does not have, or pointing at nothing any more.
 */
export async function readSharedLink(
  prisma: PrismaClient,
  token: string,
  kinds: DozoShareKinds = DOZO_SHARE_KINDS,
): Promise<DozoShared | null> {
  if (!looksLikeDozoShareToken(token)) return null;
  const hash = hashToken(token);
  const [row] = await runAsSystem(
    "share link read",
    () =>
      prisma.$queryRaw<
        Array<DozoShareTarget & { kind: string; tokenHash: string }>
      >`SELECT "userId", "spaceId", "kind", "targetId", "tokenHash" FROM dozo_share_links
      WHERE "tokenHash" = ${hash} AND "revokedAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP`,
  );
  if (!row || !timingSafeEqual(Buffer.from(row.tokenHash, "hex"), Buffer.from(hash, "hex"))) {
    return null;
  }
  const kind = kindOf(kinds, row.kind);
  if (!kind) return null;
  const { userId, spaceId, targetId } = row;
  const payload = await runAsSystem("share link read", () =>
    kind.load(prisma, { userId, spaceId, targetId }),
  );
  return payload === null || payload === undefined ? null : { kind: row.kind, payload };
}

export function dozoShareLinkRoutes(ctx: RouterContext, kinds: DozoShareKinds = DOZO_SHARE_KINDS) {
  const { deps, authed } = ctx;
  return {
    dozoShareLinks: {
      create: authed.dozoShareLinks.create.handler(async ({ context, input }) => {
        const { link, token } = await createShareLink(deps.prisma, context.actor, input, kinds);
        const url = new URL(`${DOZO_SHARE_LINK_WEB_PREFIX}${token}`, deps.env.webOrigin).href;
        return { link, url };
      }),
      list: authed.dozoShareLinks.list.handler(async ({ context }) => ({
        links: await listShareLinks(deps.prisma, context.actor),
      })),
      revoke: authed.dozoShareLinks.revoke.handler(async ({ context, input }) => {
        await revokeShareLink(deps.prisma, context.actor, input.id);
        return { revoked: true as const };
      }),
    },
  };
}

/**
 * Anyone holding a link reads what it shows here, signed out, as shared pages are read. Every
 * token that does not open a link gets the same 404, so none says whether it ever existed.
 */
export function mountDozoShareLinks(
  app: Hono,
  prisma: PrismaClient,
  clientIp: (c: Context) => string | undefined,
  kinds: DozoShareKinds = DOZO_SHARE_KINDS,
) {
  const reads = windowCounter(MINUTE_MS);
  app.get(`${DOZO_SHARE_LINK_API_PREFIX}:token`, async (c) => {
    if (reads(throttleKey(clientIp(c))) > READS_PER_IP_PER_MINUTE) {
      return c.json({ error: "Too many requests" }, 429, { ...HEADERS, "retry-after": "60" });
    }
    const shared = await readSharedLink(prisma, c.req.param("token"), kinds);
    if (!shared) return c.json({ error: "Not found" }, 404, HEADERS);
    return c.json(shared, 200, HEADERS);
  });
}
