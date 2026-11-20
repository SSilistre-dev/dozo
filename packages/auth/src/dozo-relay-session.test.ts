import { createHmac } from "node:crypto";
import { relayAgentProofMessage } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentProofMatches,
  forgetRelayAgentKey,
  issueRelaySession,
  parseRelayAgentKey,
  RECENT_SESSION_MS,
  RELAY_SESSION_USER_AGENT,
  relayAgentKey,
  revokeRelaySession,
  revokeRelaySessionsOf,
} from "./dozo-relay-session.js";
import { createAuth } from "./index.js";

/**
 * A phone's sign-in through the real `createAuth` (its bearer sign-in, its session hooks and the
 * brand rule's sign-out hook) over Better Auth's offline memory adapter.
 */

vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@rakazo/db", async (importOriginal) => {
  const { signupPolicyFromEnv } = await import("@rakazo/core");
  return {
    ...(await importOriginal<typeof import("@rakazo/db")>()),
    siteSignupPolicy: vi.fn(async (_db: unknown, env: Parameters<typeof signupPolicyFromEnv>[0]) =>
      signupPolicyFromEnv(env),
    ),
    bootstrapUserSpace: vi.fn(async (_prisma: unknown, user: { id: string }) => ({
      spaceId: `space-${user.id}`,
    })),
    leaveInvitedSpaces: vi.fn(async () => ({ ownedOrganizationIds: [] })),
    recordSecurityEvent: vi.fn(async () => undefined),
  };
});

const BASE = "http://127.0.0.1:5173";
const SECRET = "offline-auth-secret-at-least-32-characters";
const PASSWORD = "offline-password-1234";
const KEY = "a".repeat(64);
const CHANNEL = "A".repeat(22);
const OTHER = "B".repeat(22);
const DAY = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;
type Where = { id?: string; identifier?: string | { startsWith: string } };

/** What the phone sign-in and createAuth ask Prisma for, over the adapter's own rows. */
function fakePrisma() {
  const authData: Record<"user" | "account" | "session" | "verification", Row[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  let lock = Promise.resolve();
  const matches = (row: Row, where: Where) =>
    (where.id === undefined || row.id === where.id) &&
    (where.identifier === undefined ||
      (typeof where.identifier === "string"
        ? row.identifier === where.identifier
        : String(row.identifier).startsWith(where.identifier.startsWith)));
  const prisma = {
    authData,
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 1),
    // One transaction at a time, as the advisory lock makes it for a channel.
    $transaction: vi.fn((work: (tx: unknown) => Promise<unknown>) => {
      const run = lock.then(() => work(prisma));
      lock = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }),
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        signupsEnabled: true,
        signupAllowlist: "",
        signupPolicyInitialized: true,
      })),
    },
    user: {
      findMany: vi.fn(async ({ take }: { take?: number } = {}) =>
        authData.user
          .filter((user) => !String(user.email).endsWith("@messaging.invalid"))
          .slice(0, take)
          .map((user) => ({ id: user.id as string })),
      ),
      findUnique: vi.fn(async () => null),
    },
    spaceMember: { findFirst: vi.fn(async () => null) },
    session: {
      // The query's own filter: one of its OR clauses must hold, as in SQL.
      count: vi.fn(
        async ({
          where,
        }: {
          where: {
            userId: string;
            expiresAt: { gt: Date };
            updatedAt: { gt: Date };
            OR: { userAgent?: null | { not: string } }[];
          };
        }) =>
          authData.session.filter(
            (row) =>
              row.userId === where.userId &&
              (row.expiresAt as Date) > where.expiresAt.gt &&
              (row.updatedAt as Date) > where.updatedAt.gt &&
              where.OR.some((clause) =>
                clause.userAgent === null
                  ? row.userAgent == null
                  : clause.userAgent === undefined ||
                    (row.userAgent != null && row.userAgent !== clause.userAgent.not),
              ),
          ).length,
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: string | { in: string[] } } }) => {
        const ids = typeof where.id === "string" ? [where.id] : where.id.in;
        const before = authData.session.length;
        authData.session = authData.session.filter((row) => !ids.includes(row.id as string));
        return { count: before - authData.session.length };
      }),
    },
    verification: {
      findFirst: vi.fn(
        async ({ where }: { where: Where }) =>
          authData.verification.find((row) => matches(row, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        authData.verification.filter((row) => matches(row, where)),
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        authData.verification.push({ ...data });
        return data;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = authData.verification.find((item) => item.id === where.id) as Row;
        Object.assign(row, data);
        return row;
      }),
    },
  };
  return prisma;
}

/** A local server: with the relay agent's key, as the brand rule wires it, unless `keyed` is false. */
function server(keyed = true) {
  forgetRelayAgentKey();
  if (keyed) vi.stubEnv("DOZO_RELAY_AGENT_KEY", KEY);
  const prisma = fakePrisma();
  const auth = createAuth(prisma as never, {
    secret: SECRET,
    baseURL: BASE,
    webOrigin: BASE,
    signupsEnabled: "true",
    signupAllowlist: "",
  });
  const deps = { prisma: prisma as never, auth };
  const call = (path: string, init: { token?: string; body?: unknown } = {}) =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: init.body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE,
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
  /** Who the server signs a bearer token in as, or null. */
  const whoIs = async (token: string) => {
    const response = await call("/get-session", { token });
    const body = (await response.json()) as { user?: { email: string } } | null;
    return body?.user?.email ?? null;
  };
  /** A computer session of the account (made on first use): its bearer token. */
  const account = async (email = "owner@example.com", keepOthers = false) => {
    if (!prisma.authData.user.length) {
      const signedUp = await call("/sign-up/email", {
        body: { email, password: PASSWORD, name: "Owner" },
      });
      expect(signedUp.status).toBe(200);
      // A local server's account has its address confirmed; sessions need that.
      for (const user of prisma.authData.user) user.emailVerified = true;
    }
    const signedIn = await call("/sign-in/email", { body: { email, password: PASSWORD } });
    expect(signedIn.status).toBe(200);
    const token = signedIn.headers.get("set-auth-token") as string;
    if (!keepOthers) {
      // One session on the computer: the sign-up's own is not one the user keeps.
      prisma.authData.session = prisma.authData.session.filter(
        (row) => row.token === token.split(".")[0],
      );
    }
    return token;
  };
  /** A phone's session on `channel`, which must be given. */
  const phone = async (channel = CHANNEL) => {
    const result = await issueRelaySession(deps, channel);
    if (!("token" in result)) throw new Error(`refused: ${result.refused}`);
    return result.token;
  };
  return { prisma, auth, deps, call, whoIs, account, phone };
}

afterEach(() => {
  vi.unstubAllEnvs();
  forgetRelayAgentKey();
});

const proof = (request: { method: string; path: string; channel: string }, time: number) =>
  `${time}.${createHmac("sha256", KEY)
    .update(relayAgentProofMessage({ ...request, time }))
    .digest("hex")}`;

describe("the agent's key and proof", () => {
  it("is read once, must be 64 hexadecimal digits, and leaves the environment", () => {
    expect(parseRelayAgentKey(undefined)).toBeNull();
    expect(parseRelayAgentKey(` ${KEY} `)).toBe(KEY);
    expect(() => parseRelayAgentKey("short")).toThrow("64 hexadecimal");
    vi.stubEnv("DOZO_RELAY_AGENT_KEY", KEY);
    expect(relayAgentKey()).toBe(KEY);
    // Nothing this server starts inherits it.
    expect(process.env.DOZO_RELAY_AGENT_KEY).toBeUndefined();
    expect(relayAgentKey()).toBe(KEY);
  });

  it("accepts the agent's proof for this request, channel and minute only", () => {
    const request = { method: "POST", path: "/api/auth/dozo/relay-session", channel: CHANNEL };
    const now = 1_800_000_000_000;
    expect(agentProofMatches(KEY, proof(request, now), request, now)).toBe(true);
    expect(agentProofMatches(KEY, proof(request, now - 59_000), request, now)).toBe(true);
    expect(agentProofMatches(KEY, proof(request, now - 61_000), request, now)).toBe(false);
    expect(agentProofMatches(KEY, proof(request, now), { ...request, channel: OTHER }, now)).toBe(
      false,
    );
    expect(agentProofMatches(KEY, proof(request, now), { ...request, path: "/x" }, now)).toBe(
      false,
    );
    expect(agentProofMatches("b".repeat(64), proof(request, now), request, now)).toBe(false);
    expect(agentProofMatches(KEY, `${now}.${"0".repeat(64)}`, request, now)).toBe(false);
    expect(agentProofMatches(KEY, KEY, request, now)).toBe(false);
    expect(agentProofMatches(KEY, undefined, request, now)).toBe(false);
    expect(agentProofMatches(null, proof(request, now), request, now)).toBe(false);
  });
});

describe("a server without the agent's key", () => {
  it("is as before: no phone sign-in endpoint, and signing out reads nothing of it", async () => {
    const { auth, account, call, prisma } = server(false);
    expect((auth.api as Record<string, unknown>).dozoRelaySessionCreate).toBeUndefined();
    const token = await account();
    await call("/sign-out", { token, body: {} });
    expect(prisma.verification.findMany).not.toHaveBeenCalled();
  });
});

describe("a phone's sign-in", () => {
  it("signs the phone in as the computer's account, with a token the server accepts", async () => {
    const { account, whoIs, prisma, phone } = server();
    await account();
    const token = await phone();
    expect(await whoIs(token)).toBe("owner@example.com");
    expect(await whoIs(token.slice(0, -2))).toBeNull();
    expect(
      prisma.authData.session.filter((row) => row.userAgent === RELAY_SESSION_USER_AGENT),
    ).toHaveLength(1);
  });

  it("gives each channel one sign-in, ever, even when asked twice at once", async () => {
    const { deps, account } = server();
    await account();
    const both = await Promise.all([
      issueRelaySession(deps, CHANNEL),
      issueRelaySession(deps, CHANNEL),
    ]);
    expect(both.filter((result) => "token" in result)).toHaveLength(1);
    expect(both).toContainEqual({ refused: "used" });
    expect(await issueRelaySession(deps, CHANNEL)).toEqual({ refused: "used" });
    expect("token" in (await issueRelaySession(deps, OTHER))).toBe(true);
  });

  it("gives none while nobody is signed in on the computer, or only long ago", async () => {
    const { deps, account, call, prisma } = server();
    expect(await issueRelaySession(deps, CHANNEL)).toEqual({ refused: "sign-in-on-computer" });
    const token = await account();
    for (const row of prisma.authData.session) {
      row.updatedAt = new Date(Date.now() - RECENT_SESSION_MS - DAY);
    }
    expect(await issueRelaySession(deps, CHANNEL)).toEqual({ refused: "sign-in-on-computer" });
    for (const row of prisma.authData.session) row.updatedAt = new Date();
    await call("/sign-out", { token, body: {} });
    expect(await issueRelaySession(deps, OTHER)).toEqual({ refused: "sign-in-on-computer" });
  });

  it("does not count a phone's own sign-in as the computer's", async () => {
    const { deps, account, prisma, phone } = server();
    await account();
    await phone();
    prisma.authData.session = prisma.authData.session.filter(
      (row) => row.userAgent === RELAY_SESSION_USER_AGENT,
    );
    expect(await issueRelaySession(deps, OTHER)).toEqual({ refused: "sign-in-on-computer" });
  });

  it("refuses a computer with more than one account", async () => {
    const { deps, account, prisma } = server();
    await account();
    prisma.authData.user.push({ id: "second", email: "second@example.com" });
    expect(await issueRelaySession(deps, CHANNEL)).toEqual({ refused: "one-account" });
  });

  it("lets a phone do nothing that ends other sessions or changes how the account signs in", async () => {
    const { account, whoIs, call, phone } = server();
    const computer = await account();
    const token = await phone();
    for (const [path, body] of [
      ["/revoke-other-sessions", {}],
      ["/revoke-sessions", {}],
      ["/revoke-session", { token: computer.split(".")[0] }],
      ["/change-password", { currentPassword: PASSWORD, newPassword: "another-password-1234" }],
      ["/delete-user", {}],
    ] as const) {
      expect((await call(path, { token, body })).status, path).toBe(403);
    }
    // Under any prefix of the rule, and with the token written as a header may encode it.
    expect((await call("/passkey/generate-register-options", { token })).status).toBe(403);
    expect(
      (await call("/revoke-other-sessions", { token: encodeURIComponent(token), body: {} })).status,
    ).toBe(403);
    // A request with no bearer token is the server's own rules' to answer.
    expect((await call("/revoke-other-sessions", { body: {} })).status).toBe(401);
    expect(await whoIs(computer)).toBe("owner@example.com");
    expect(await whoIs(token)).toBe("owner@example.com");
    // The computer still may.
    expect((await call("/revoke-other-sessions", { token: computer, body: {} })).status).toBe(200);
    expect(await whoIs(token)).toBeNull();
  });
});

describe("ending a phone's sign-in", () => {
  it("ends it when the phone is removed, and the channel gets no new one", async () => {
    const { deps, account, whoIs, prisma, phone } = server();
    await account();
    const first = await phone(CHANNEL);
    const other = await phone(OTHER);
    await revokeRelaySession(prisma as never, CHANNEL);
    expect(await whoIs(first)).toBeNull();
    expect(await whoIs(other)).toBe("owner@example.com");
    expect(await issueRelaySession(deps, CHANNEL)).toEqual({ refused: "used" });
    // A channel that never had one, and a record this code did not write, end nothing.
    await revokeRelaySession(prisma as never, "C".repeat(22));
    prisma.authData.verification.push({
      id: "x",
      identifier: `dozo-relay-session:${"D".repeat(22)}`,
      value: "{",
    });
    await revokeRelaySession(prisma as never, "D".repeat(22));
    expect(await whoIs(other)).toBe("owner@example.com");
  });

  it("ends the phones when the user signs out on the computer, not when a phone does", async () => {
    const { account, whoIs, call, phone } = server();
    const computer = await account();
    const first = await phone(CHANNEL);
    const second = await phone(OTHER);
    await call("/sign-out", { token: first, body: {} });
    expect(await whoIs(first)).toBeNull();
    expect(await whoIs(second)).toBe("owner@example.com");
    await call("/sign-out", { token: computer, body: {} });
    expect(await whoIs(second)).toBeNull();
  });

  it("ends the phones when the computer's last session ends by any way, not while one is left", async () => {
    const { account, whoIs, call, phone } = server();
    const computer = await account();
    const browser = await account("owner@example.com", true);
    const token = await phone();
    await call("/revoke-session", { token: computer, body: { token: browser.split(".")[0] } });
    expect(await whoIs(token)).toBe("owner@example.com");
    await call("/revoke-session", { token: computer, body: { token: computer.split(".")[0] } });
    expect(await whoIs(token)).toBeNull();
  });

  it("ends the phones when the user signs out everywhere", async () => {
    const { account, whoIs, call, phone } = server();
    const computer = await account();
    const token = await phone();
    await call("/revoke-sessions", { token: computer, body: {} });
    expect(await whoIs(token)).toBeNull();
  });

  it.each([
    ["the only computer session", false],
    ["one of two computer sessions", true],
  ])("ends a session made while the user signed out of %s", async (_name, twoSessions) => {
    const { auth, account, call, prisma } = server();
    const computer = await account();
    if (twoSessions) await account("owner@example.com", true);
    // The sign-out lands after the channel is claimed and before the session's record is written.
    const racing = {
      prisma: prisma as never,
      auth: {
        api: {
          dozoRelaySessionCreate: async (input: { query: { userId: string } }) => {
            const made = await auth.api.dozoRelaySessionCreate(input);
            await call("/sign-out", { token: computer, body: {} });
            return made;
          },
        },
      },
    };
    expect(await issueRelaySession(racing, CHANNEL)).toEqual({ refused: "sign-in-on-computer" });
    expect(
      prisma.authData.session.filter((row) => row.userAgent === RELAY_SESSION_USER_AGENT),
    ).toEqual([]);
  });

  it("leaves other users' phones alone and skips records it cannot read", async () => {
    const { prisma } = server();
    prisma.authData.session.push({ id: "s1", userId: "u1" }, { id: "s2", userId: "u2" });
    prisma.authData.verification.push(
      {
        id: "1",
        identifier: "dozo-relay-session:x",
        value: JSON.stringify({ userId: "u1", sessionId: "s1" }),
      },
      {
        id: "2",
        identifier: "dozo-relay-session:y",
        value: JSON.stringify({ userId: "u2", sessionId: "s2" }),
      },
      { id: "3", identifier: "dozo-relay-session:z", value: JSON.stringify({ userId: "u1" }) },
      { id: "4", identifier: "dozo-relay-session:w", value: "[]" },
      { id: "5", identifier: "dozo-relay-session:v", value: "nope" },
      { id: "6", identifier: "dozo-relay-session:u", value: "null" },
    );
    await revokeRelaySessionsOf(prisma as never, "u1");
    expect(prisma.authData.session.map((row) => row.id)).toEqual(["s2"]);
    // The record of a session still being made is marked, so it cannot survive.
    expect(JSON.parse(String(prisma.authData.verification[2]?.value))).toEqual({
      userId: "u1",
      revoked: true,
    });
    await revokeRelaySessionsOf(prisma as never, "u3");
    expect(prisma.authData.session).toHaveLength(1);
  });
});
