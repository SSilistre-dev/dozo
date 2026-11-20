import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentKeyMatches,
  issueRelaySession,
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

type Row = Record<string, unknown>;

/** What the phone sign-in and createAuth ask Prisma for, over the adapter's own rows. */
function fakePrisma() {
  const authData: Record<"user" | "account" | "session" | "verification", Row[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  let lock = Promise.resolve();
  const live = (row: Row, now: Date) => (row.expiresAt as Date) > now;
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
            OR: { userAgent?: null | { not: string } }[];
          };
        }) =>
          authData.session.filter(
            (row) =>
              row.userId === where.userId &&
              live(row, where.expiresAt.gt) &&
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
        async ({ where }: { where: { identifier: string } }) =>
          authData.verification.find((row) => row.identifier === where.identifier) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { identifier: { startsWith: string } } }) =>
        authData.verification.filter((row) =>
          String(row.identifier).startsWith(where.identifier.startsWith),
        ),
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

function server() {
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
  /** The account, signed in on the computer: its session's bearer token. */
  const account = async (email = "owner@example.com") => {
    const signedUp = await call("/sign-up/email", {
      body: { email, password: PASSWORD, name: "Owner" },
    });
    expect(signedUp.status).toBe(200);
    // A local server's account has its address confirmed; sessions need that.
    for (const user of prisma.authData.user) user.emailVerified = true;
    const signedIn = await call("/sign-in/email", { body: { email, password: PASSWORD } });
    expect(signedIn.status).toBe(200);
    const token = signedIn.headers.get("set-auth-token") as string;
    // One session on the computer: the sign-up's own is not the one the user keeps.
    prisma.authData.session = prisma.authData.session.filter(
      (row) => row.token === token.split(".")[0],
    );
    return token;
  };
  return { prisma, auth, deps, call, whoIs, account };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the agent's key", () => {
  it("is read from the environment and must be 64 hexadecimal digits", () => {
    expect(relayAgentKey({})).toBeNull();
    expect(relayAgentKey({ DOZO_RELAY_AGENT_KEY: ` ${KEY} ` })).toBe(KEY);
    expect(() => relayAgentKey({ DOZO_RELAY_AGENT_KEY: "short" })).toThrow("64 hexadecimal");
  });

  it("matches only the agent's own key", () => {
    expect(agentKeyMatches(KEY, KEY)).toBe(true);
    expect(agentKeyMatches(KEY, "b".repeat(64))).toBe(false);
    expect(agentKeyMatches(KEY, "a".repeat(63))).toBe(false);
    expect(agentKeyMatches(KEY, `${"a".repeat(63)}A`)).toBe(false);
    expect(agentKeyMatches(KEY, undefined)).toBe(false);
    expect(agentKeyMatches(null, KEY)).toBe(false);
  });
});

describe("a phone's sign-in", () => {
  it("signs the phone in as the computer's account, with a token the server accepts", async () => {
    const { deps, account, whoIs, prisma } = server();
    await account();
    const result = await issueRelaySession(deps, CHANNEL);
    if (!("token" in result)) throw new Error(`refused: ${result.refused}`);
    expect(await whoIs(result.token)).toBe("owner@example.com");
    expect(await whoIs(result.token.slice(0, -2))).toBeNull();
    const phone = prisma.authData.session.find((row) => row.userAgent === RELAY_SESSION_USER_AGENT);
    expect(phone).toBeTruthy();
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

  it("gives none while nobody is signed in on the computer", async () => {
    const { deps, account, call } = server();
    expect(await issueRelaySession(deps, CHANNEL)).toEqual({ refused: "sign-in-on-computer" });
    const token = await account();
    await call("/sign-out", { token, body: {} });
    expect(await issueRelaySession(deps, CHANNEL)).toEqual({ refused: "sign-in-on-computer" });
  });

  it("does not count a phone's own sign-in as the computer's", async () => {
    const { deps, account, call, whoIs } = server();
    const computer = await account();
    const phone = await issueRelaySession(deps, CHANNEL);
    if (!("token" in phone)) throw new Error("refused");
    // Ending one computer session by itself (not signing out) leaves the phone signed in.
    await call("/revoke-session", { token: computer, body: { token: computer.split(".")[0] } });
    expect(await whoIs(phone.token)).toBe("owner@example.com");
    expect(await issueRelaySession(deps, OTHER)).toEqual({ refused: "sign-in-on-computer" });
  });

  it("ends a session made while the user signed out on the computer", async () => {
    const { deps, account, prisma, call } = server();
    const computer = await account();
    // The sign-out lands after the first check and before the session's record is written.
    prisma.verification.update.mockImplementationOnce(async ({ where, data }) => {
      await call("/sign-out", { token: computer, body: {} });
      const row = prisma.authData.verification.find((item) => item.id === where.id) as Row;
      Object.assign(row, data);
      return row;
    });
    expect(await issueRelaySession(deps, CHANNEL)).toEqual({ refused: "sign-in-on-computer" });
    expect(
      prisma.authData.session.filter((row) => row.userAgent === RELAY_SESSION_USER_AGENT),
    ).toEqual([]);
  });

  it("ends the phones' sign-ins when the user signs out everywhere", async () => {
    const { deps, account, whoIs, call } = server();
    const computer = await account();
    const phone = await issueRelaySession(deps, CHANNEL);
    if (!("token" in phone)) throw new Error("refused");
    await call("/revoke-sessions", { token: computer, body: {} });
    expect(await whoIs(phone.token)).toBeNull();
  });

  it("refuses a computer with more than one account", async () => {
    const { deps, account, prisma } = server();
    await account();
    prisma.authData.user.push({ id: "second", email: "second@example.com" });
    expect(await issueRelaySession(deps, CHANNEL)).toEqual({ refused: "one-account" });
  });
});

describe("ending a phone's sign-in", () => {
  it("ends it when the phone is removed, and the channel gets no new one", async () => {
    const { deps, account, whoIs, prisma } = server();
    await account();
    const first = await issueRelaySession(deps, CHANNEL);
    const other = await issueRelaySession(deps, OTHER);
    if (!("token" in first) || !("token" in other)) throw new Error("refused");
    await revokeRelaySession(prisma as never, CHANNEL);
    expect(await whoIs(first.token)).toBeNull();
    expect(await whoIs(other.token)).toBe("owner@example.com");
    expect(await issueRelaySession(deps, CHANNEL)).toEqual({ refused: "used" });
    // A channel that never had one, and a record this code did not write, end nothing.
    await revokeRelaySession(prisma as never, "C".repeat(22));
    prisma.authData.verification.push({
      identifier: `dozo-relay-session:${"D".repeat(22)}`,
      value: "{",
    });
    await revokeRelaySession(prisma as never, "D".repeat(22));
    expect(await whoIs(other.token)).toBe("owner@example.com");
  });

  it("ends the phones' sign-ins when the user signs out on the computer, not when a phone does", async () => {
    const { deps, account, whoIs, call } = server();
    const computer = await account();
    const first = await issueRelaySession(deps, CHANNEL);
    const second = await issueRelaySession(deps, OTHER);
    if (!("token" in first) || !("token" in second)) throw new Error("refused");
    await call("/sign-out", { token: first.token, body: {} });
    expect(await whoIs(first.token)).toBeNull();
    expect(await whoIs(second.token)).toBe("owner@example.com");
    expect(await whoIs(computer)).toBe("owner@example.com");
    await call("/sign-out", { token: computer, body: {} });
    expect(await whoIs(second.token)).toBeNull();
  });

  it("leaves other users' phones alone and skips records it cannot read", async () => {
    const { prisma } = server();
    prisma.authData.session.push({ id: "s1", userId: "u1" }, { id: "s2", userId: "u2" });
    prisma.authData.verification.push(
      {
        identifier: "dozo-relay-session:x",
        value: JSON.stringify({ userId: "u1", sessionId: "s1" }),
      },
      {
        identifier: "dozo-relay-session:y",
        value: JSON.stringify({ userId: "u2", sessionId: "s2" }),
      },
      { identifier: "dozo-relay-session:z", value: JSON.stringify({ userId: "u1" }) },
      { identifier: "dozo-relay-session:w", value: "[]" },
      { identifier: "dozo-relay-session:v", value: "nope" },
    );
    await revokeRelaySessionsOf(prisma as never, "u1");
    expect(prisma.authData.session.map((row) => row.id)).toEqual(["s2"]);
    await revokeRelaySessionsOf(prisma as never, "u3");
    expect(prisma.authData.session).toHaveLength(1);
  });
});
