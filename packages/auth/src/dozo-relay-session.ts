import { randomUUID, timingSafeEqual } from "node:crypto";
import type { RelaySessionRefusal } from "@rakazo/contracts";
import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { makeSignature } from "better-auth/crypto";

/**
 * A paired phone's sign-in, given by the user's own computer (`dozo/relay/agent/README.md`, Phone
 * sign-in). The local server signs the phone in as the one account it has, while that account is
 * signed in on the computer: pairing needed the QR code the computer showed, so it is that user's
 * consent, and the phone never sees a password. Each channel gets one session, ever: after it
 * ends (the phone removed, signed out there, or the user signed out on the computer) the phone
 * pairs again. Only the computer's relay agent may ask, with a key it shares with this server
 * (`DOZO_RELAY_AGENT_KEY`); without that key set, nothing here is reachable.
 */

/** The user agent a phone's session is stored under: tells it from the computer's own sessions. */
export const RELAY_SESSION_USER_AGENT = "dozo-relay-phone";
const RECORD_PREFIX = "dozo-relay-session:";
/** The requests that sign the user out on the computer: this session, or all of them. */
const SIGN_OUT_PATHS = new Set(["/sign-out", "/revoke-sessions"]);
const AGENT_KEY = /^[a-f0-9]{64}$/;
/** The record that a channel had its session stays as long as the database does. */
const RECORD_EXPIRES = new Date("9999-12-31T00:00:00Z");

/** The agent's key, or null when this server gives phones no sign-in. A malformed key stops it. */
export function relayAgentKey(source: NodeJS.ProcessEnv = process.env): string | null {
  const key = source.DOZO_RELAY_AGENT_KEY?.trim();
  if (!key) return null;
  if (!AGENT_KEY.test(key)) throw new Error("DOZO_RELAY_AGENT_KEY must be 64 hexadecimal digits");
  return key;
}

/** Compares the key a request carries with the agent's, in constant time. */
export function agentKeyMatches(expected: string | null, supplied: string | undefined): boolean {
  if (!expected || !supplied || !AGENT_KEY.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
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

const humans = { NOT: { email: { endsWith: MESSAGING_EMAIL_SUFFIX } } };

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
  const users = await prisma.user.findMany({ where: humans, select: { id: true }, take: 2 });
  if (users.length > 1) return { refused: "one-account" };
  const userId = users[0]?.id;
  if (!userId) return { refused: "sign-in-on-computer" };
  const signedIn = await prisma.session.count({
    where: {
      userId,
      expiresAt: { gt: now },
      OR: [{ userAgent: null }, { userAgent: { not: RELAY_SESSION_USER_AGENT } }],
    },
  });
  if (signedIn === 0) return { refused: "sign-in-on-computer" };

  const identifier = `${RECORD_PREFIX}${channel}`;
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${identifier}))`;
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
  await prisma.verification.update({
    where: { id: claimed },
    data: { value: JSON.stringify({ userId, sessionId: session.id }) },
  });
  return { token: session.token };
}

/** A channel's record, or null for one this code did not write. */
function recordOf(value: string): { userId: string; sessionId?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const { userId, sessionId } = (parsed ?? {}) as { userId?: unknown; sessionId?: unknown };
  if (typeof userId !== "string") return null;
  return typeof sessionId === "string" ? { userId, sessionId } : { userId };
}

/** Ends the phone's session on `channel`. The channel keeps its record: it gets no second one. */
export async function revokeRelaySession(
  prisma: Pick<PrismaClient, "session" | "verification">,
  channel: string,
) {
  const record = await prisma.verification.findFirst({
    where: { identifier: `${RECORD_PREFIX}${channel}` },
    select: { value: true },
  });
  const sessionId = record ? recordOf(record.value)?.sessionId : undefined;
  if (sessionId) await prisma.session.deleteMany({ where: { id: sessionId } });
}

/** Ends every phone session `userId` was given on this server. */
export async function revokeRelaySessionsOf(
  prisma: Pick<PrismaClient, "session" | "verification">,
  userId: string,
) {
  const records = await prisma.verification.findMany({
    where: { identifier: { startsWith: RECORD_PREFIX } },
    select: { value: true },
  });
  const ids = records
    .map((record) => recordOf(record.value))
    .filter((record) => record?.userId === userId && record.sessionId)
    .map((record) => record?.sessionId as string);
  if (ids.length > 0) await prisma.session.deleteMany({ where: { id: { in: ids } } });
}

/** Signing out on the computer signs out its phones too; a phone signing out ends only its own. */
export function dozoRelaySessions(deps: {
  prisma: Pick<PrismaClient, "session" | "verification">;
}) {
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
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            delete: {
              after: async (session, context) => {
                // Only a sign-out by the user ends the phones: a computer session that merely
                // expired, or a phone signing itself out, does not.
                if (!SIGN_OUT_PATHS.has(context?.path ?? "")) return;
                if (session.userAgent === RELAY_SESSION_USER_AGENT) return;
                await revokeRelaySessionsOf(deps.prisma, session.userId);
              },
            },
          },
        },
      },
    }),
  } satisfies BetterAuthPlugin;
}
