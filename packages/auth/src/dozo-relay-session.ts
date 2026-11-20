import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { RelaySessionRefusal } from "@rakazo/contracts";
import { relayAgentProofMessage } from "@rakazo/contracts";
import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { makeSignature } from "better-auth/crypto";

/**
 * A paired phone's sign-in, given by the user's own computer (`dozo/relay/agent/README.md`, Phone
 * sign-in). The local server signs the phone in as the one account it has. Only the computer's
 * relay agent may ask, and only after the user approved the phone on the computer; the agent
 * proves it holds the key it shares with this server (`DOZO_RELAY_AGENT_KEY`). Each channel gets
 * one session, ever: after it ends the phone pairs again. Without the key, none of this is wired.
 */

/** The user agent a phone's session is stored under: tells it from the computer's own sessions. */
export const RELAY_SESSION_USER_AGENT = "dozo-relay-phone";
const RECORD_PREFIX = "dozo-relay-session:";
/** When the user last signed out on the computer: a phone session made since does not survive. */
const SIGNED_OUT_PREFIX = "dozo-relay-signed-out:";
/** The requests that sign the user out on the computer: this session, or all of them. */
const SIGN_OUT_PATHS = new Set(["/sign-out", "/revoke-sessions"]);
/** What a phone's session may not do: end other sessions or change how the account signs in. */
const COMPUTER_ONLY_PATHS = [
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/change-password",
  "/set-password",
  "/change-email",
  "/delete-user",
  "/delete-user/",
  "/request-account-deletion",
  "/email-otp/",
  "/link-social",
  "/unlink-account",
  "/passkey/",
  "/two-factor/",
];
/** A computer session counts as signed in only if it was used this recently. */
export const RECENT_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
/** How far the agent's clock may be from this server's. */
const PROOF_WINDOW_MS = 60_000;
const AGENT_KEY = /^[a-f0-9]{64}$/;
const PROOF = /^(\d{13})\.([a-f0-9]{64})$/;
/** The record that a channel had its session stays as long as the database does. */
const RECORD_EXPIRES = new Date("9999-12-31T00:00:00Z");

/** The key's value as configured: null when unset, an error when malformed. */
export function parseRelayAgentKey(value: string | undefined): string | null {
  const key = value?.trim();
  if (!key) return null;
  if (!AGENT_KEY.test(key)) throw new Error("DOZO_RELAY_AGENT_KEY must be 64 hexadecimal digits");
  return key;
}

let configuredKey: { key: string | null } | null = null;

/**
 * The agent's key, or null when this server gives phones no sign-in. Read once and then taken out
 * of the environment, so no process this server starts (a bot's command, a tool) inherits it.
 */
export function relayAgentKey(): string | null {
  if (!configuredKey) {
    configuredKey = { key: parseRelayAgentKey(process.env.DOZO_RELAY_AGENT_KEY) };
    delete process.env.DOZO_RELAY_AGENT_KEY;
  }
  return configuredKey.key;
}

/** For tests: read the environment again on the next call. */
export function forgetRelayAgentKey() {
  configuredKey = null;
}

/**
 * Checks the agent's proof for a request: an HMAC of the method, path, channel and time under the
 * shared key, within a minute of now, compared in constant time. The key itself never travels, so
 * whatever answers on the agent's `--origin` learns nothing it can use for long.
 */
export function agentProofMatches(
  key: string | null,
  proof: string | undefined,
  request: { method: string; path: string; channel: string },
  now = Date.now(),
): boolean {
  const match = key && proof ? PROOF.exec(proof) : null;
  if (!key || !match) return false;
  const [, time, mac] = match as unknown as [string, string, string];
  if (Math.abs(now - Number(time)) > PROOF_WINDOW_MS) return false;
  const expected = createHmac("sha256", key)
    .update(relayAgentProofMessage({ ...request, time: Number(time) }))
    .digest("hex");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(mac));
}

export type RelaySessionPrisma = Pick<
  PrismaClient,
  "user" | "session" | "verification" | "$transaction"
>;

/**
 * The auth instance's server-only endpoint that makes a phone's session (below), so the session
 * passes the same checks every sign-in does.
 */
export type RelaySessionAuth = {
  api: {
    dozoRelaySessionCreate(input: {
      query: { userId: string };
    }): Promise<{ id: string; token: string }>;
  };
};

export type RelaySessionResult = { token: string } | { refused: RelaySessionRefusal };

type ChannelRecord = { userId: string; sessionId?: string; revoked?: boolean };

const humans = { NOT: { email: { endsWith: MESSAGING_EMAIL_SUFFIX } } };

/**
 * Whether the user has a session on the computer that is still valid and was used in the last
 * 30 days: any session not a phone's, in any browser on this computer (the server answers only
 * there). The user's approval on the computer, checked by the agent, is the real gate; this keeps
 * a long-abandoned sign-in from being enough.
 */
function computerSignedIn(prisma: Pick<PrismaClient, "session">, userId: string, now: Date) {
  return prisma.session.count({
    where: {
      userId,
      expiresAt: { gt: now },
      updatedAt: { gt: new Date(now.getTime() - RECENT_SESSION_MS) },
      OR: [{ userAgent: null }, { userAgent: { not: RELAY_SESSION_USER_AGENT } }],
    },
  });
}

/** A channel's record under its lock, so a session's id and a revocation never miss each other. */
function withRecord<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  identifier: string,
  work: (tx: Pick<PrismaClient, "verification">) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${identifier}))`;
    return work(tx);
  });
}

/**
 * A session for the phone on `channel`, as this server's one account, or why there is none. The
 * channel is claimed under a lock first, so two requests for it never both get one.
 */
export async function issueRelaySession(
  deps: { prisma: RelaySessionPrisma; auth: RelaySessionAuth; now?: () => Date },
  channel: string,
): Promise<RelaySessionResult> {
  const { prisma } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const started = Date.now();
  const users = await prisma.user.findMany({ where: humans, select: { id: true }, take: 2 });
  if (users.length > 1) return { refused: "one-account" };
  const userId = users[0]?.id;
  if (!userId) return { refused: "sign-in-on-computer" };
  if ((await computerSignedIn(prisma, userId, now)) === 0) {
    return { refused: "sign-in-on-computer" };
  }

  const identifier = `${RECORD_PREFIX}${channel}`;
  const claimed = await withRecord(prisma, identifier, async (tx) => {
    if (await tx.verification.findFirst({ where: { identifier }, select: { id: true } })) {
      return null;
    }
    const record = await tx.verification.create({
      data: {
        id: randomUUID(),
        identifier,
        value: JSON.stringify({ userId }),
        expiresAt: RECORD_EXPIRES,
      },
      select: { id: true },
    });
    return record.id;
  });
  if (!claimed) return { refused: "used" };

  const session = await deps.auth.api.dozoRelaySessionCreate({ query: { userId } });
  // A sign-out on the computer while the session was made marked the record revoked; from here on
  // a sign-out finds the session by the record. Either way none is missed.
  const kept = await withRecord(prisma, identifier, async (tx) => {
    const record = await tx.verification.findFirst({
      where: { id: claimed },
      select: { value: true },
    });
    if (!record || recordOf(record.value)?.revoked) return false;
    await tx.verification.update({
      where: { id: claimed },
      data: { value: JSON.stringify({ userId, sessionId: session.id } satisfies ChannelRecord) },
    });
    return true;
  });
  // A sign-out from any session on the computer since this request began counts too, even one
  // that came before the channel was claimed and left another computer session signed in.
  const signedOut = await prisma.verification.findFirst({
    where: { identifier: `${SIGNED_OUT_PREFIX}${userId}` },
    select: { value: true },
  });
  const signedOutSince = Number(signedOut?.value ?? 0) >= started;
  if (!kept || signedOutSince || (await computerSignedIn(prisma, userId, new Date())) === 0) {
    await prisma.session.deleteMany({ where: { id: session.id } });
    return { refused: "sign-in-on-computer" };
  }
  return { token: session.token };
}

/** A channel's record, or null for one this code did not write. */
function recordOf(value: string): ChannelRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const { userId, sessionId, revoked } = (parsed ?? {}) as Partial<ChannelRecord>;
  if (typeof userId !== "string") return null;
  return {
    userId,
    ...(typeof sessionId === "string" ? { sessionId } : {}),
    ...(revoked === true ? { revoked } : {}),
  };
}

/** Ends the phone's session on `channel`. The channel keeps its record: it gets no second one. */
export async function revokeRelaySession(
  prisma: Pick<PrismaClient, "session" | "verification" | "$transaction">,
  channel: string,
) {
  const identifier = `${RECORD_PREFIX}${channel}`;
  const record = await prisma.verification.findFirst({ where: { identifier } });
  if (record) await revokeRecord(prisma, record);
}

/** Ends one record's session, or marks it revoked when its session is still being made. */
async function revokeRecord(
  prisma: Pick<PrismaClient, "session" | "$transaction">,
  record: { id: string; identifier: string },
) {
  const sessionId = await withRecord(prisma, record.identifier, async (tx) => {
    const current = await tx.verification.findFirst({
      where: { id: record.id },
      select: { value: true },
    });
    const parsed = current ? recordOf(current.value) : null;
    if (!parsed) return undefined;
    if (!parsed.sessionId) {
      await tx.verification.update({
        where: { id: record.id },
        data: { value: JSON.stringify({ ...parsed, revoked: true }) },
      });
    }
    return parsed.sessionId;
  });
  if (sessionId) await prisma.session.deleteMany({ where: { id: sessionId } });
}

/** Ends every phone session `userId` was given on this server, including one being made now. */
export async function revokeRelaySessionsOf(
  prisma: Pick<PrismaClient, "session" | "verification" | "$transaction">,
  userId: string,
) {
  const records = await prisma.verification.findMany({
    where: { identifier: { startsWith: RECORD_PREFIX } },
    select: { id: true, identifier: true, value: true },
  });
  for (const record of records) {
    if (recordOf(record.value)?.userId === userId) await revokeRecord(prisma, record);
  }
}

/** Records the time the user signed out on the computer, for a phone session made meanwhile. */
async function markSignedOut(prisma: Pick<PrismaClient, "verification">, userId: string) {
  const identifier = `${SIGNED_OUT_PREFIX}${userId}`;
  const value = String(Date.now());
  const existing = await prisma.verification.findFirst({
    where: { identifier },
    select: { id: true },
  });
  if (existing) await prisma.verification.update({ where: { id: existing.id }, data: { value } });
  else {
    await prisma.verification.create({
      data: { id: randomUUID(), identifier, value, expiresAt: RECORD_EXPIRES },
    });
  }
}

/** A session token's id part, as Better Auth reads a signed one, from a bearer header or cookie. */
function tokenPart(value: string) {
  return (value.includes("%") ? decodeURIComponent(value) : value).split(".")[0] || null;
}

/**
 * Every session a request may sign in with: its bearer token and its session cookie. A phone
 * holds the cookie's value too, so both are looked at, not only the header.
 */
function requestTokens(headers: Headers | undefined, cookieName: string) {
  const tokens: string[] = [];
  const bearer = headers?.get("authorization");
  if (bearer?.slice(0, 7).toLowerCase() === "bearer ") {
    const token = tokenPart(bearer.slice(7).trim());
    if (token) tokens.push(token);
  }
  for (const part of (headers?.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== cookieName && name !== `__Secure-${cookieName}`) continue;
    const token = tokenPart(rest.join("="));
    if (token) tokens.push(token);
  }
  return tokens;
}

/**
 * The phone sessions' rules inside Better Auth: the endpoint that makes one; a phone may not end
 * other sessions or change how the account signs in; and the phones' sessions end when the user
 * signs out on the computer, or when the user's last computer session ends by any way at all.
 */
export function dozoRelaySessions(deps: {
  prisma: Pick<PrismaClient, "session" | "verification" | "$transaction">;
}) {
  const now = () => new Date();
  return {
    id: "dozo-relay-sessions",
    endpoints: {
      // No address: only the server calls it, from `issueRelaySession`.
      dozoRelaySessionCreate: createAuthEndpoint.serverOnly({ method: "POST" }, async (context) => {
        const userId: unknown = context.query?.userId;
        if (typeof userId !== "string") throw new APIError("BAD_REQUEST");
        const session = await context.context.internalAdapter.createSession(userId, false, {
          userAgent: RELAY_SESSION_USER_AGENT,
        });
        // The signed form a bearer sign-in carries, as the session cookie holds it.
        const signature = await makeSignature(session.token, context.context.secret);
        return { id: session.id, token: `${session.token}.${signature}` };
      }),
    },
    hooks: {
      before: [
        {
          matcher: (context) =>
            COMPUTER_ONLY_PATHS.some((path) =>
              path.endsWith("/") ? context.path?.startsWith(path) : context.path === path,
            ),
          handler: createAuthMiddleware(async (context) => {
            const cookieName = context.context.authCookies.sessionToken.name;
            for (const token of requestTokens(context.headers, cookieName)) {
              const found = await context.context.internalAdapter.findSession(token);
              if (found?.session.userAgent === RELAY_SESSION_USER_AGENT) {
                throw new APIError("FORBIDDEN", { message: "Do this on your computer" });
              }
            }
          }),
        },
      ],
    },
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            delete: {
              after: async (session, context) => {
                if (session.userAgent === RELAY_SESSION_USER_AGENT) return;
                const signedOut = SIGN_OUT_PATHS.has(context?.path ?? "");
                if (signedOut) await markSignedOut(deps.prisma, session.userId);
                if (
                  !signedOut &&
                  (await computerSignedIn(deps.prisma, session.userId, now())) > 0
                ) {
                  return;
                }
                await revokeRelaySessionsOf(deps.prisma, session.userId);
              },
            },
          },
        },
      },
    }),
  } satisfies BetterAuthPlugin;
}

/** The plugin, only on a server that gives phones a sign-in; otherwise nothing changes. */
export function dozoRelaySessionsWhenKeyed(deps: Parameters<typeof dozoRelaySessions>[0]) {
  return relayAgentKey() ? [dozoRelaySessions(deps)] : [];
}
