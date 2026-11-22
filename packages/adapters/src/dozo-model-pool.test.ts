import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { POOL_REFUSED_COOLDOWN_MS } from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  pooled: new Map<string, Date | null>(),
  readModelPool: vi.fn(),
  findModelCredentialById: vi.fn(),
  recordModelConnectionCooldown: vi.fn(),
}));

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  readModelPool: db.readModelPool,
  findModelCredentialById: db.findModelCredentialById,
  recordModelConnectionCooldown: db.recordModelConnectionCooldown,
}));

import type { RunModelPool } from "./dozo-model-pool.js";
import {
  connectionOutReason,
  loadRunModelPool,
  poolResetAt,
  skipsPoolMember,
  switchAfterFailure,
  withPoolMembers,
  withRunModelPool,
} from "./dozo-model-pool.js";
import { serializeModelSecret } from "./model-secret.js";
import { OAUTH_RECONNECT_REQUIRED_ERROR } from "./pi-oauth.js";

const now = Date.UTC(2026, 10, 20, 12);
const HOUR = 60 * 60_000;
const USER = "user-1";
const MODEL = "model-1";

const credential = (id: string) =>
  ({ id, userId: USER, provider: "provider-a", defaultModel: null, thinkingLevel: null }) as never;

const signIn = (accountId?: string, reconnectRequired = false) =>
  reconnectRequired
    ? JSON.stringify({ kind: "oauth", reconnectRequired: true })
    : serializeModelSecret({
        kind: "oauth",
        credential: {
          type: "oauth",
          access: "fake-access",
          refresh: "fake-refresh",
          expires: 1,
          ...(accountId ? { accountId } : {}),
        },
      });

/**
 * Connections a to e of provider-a, added in that order: c is a subscription sign-in, d's secret is
 * gone and e's no longer parses. `more` adds connections after them, by id and secret.
 */
function deps(more: Record<string, string> = {}) {
  const secrets: Record<string, string> = {
    "secret-a": serializeModelSecret({ kind: "api_key", key: "fake-key-a" }),
    "secret-b": serializeModelSecret({ kind: "api_key", key: "fake-key-b" }),
    "secret-c": signIn("account-1"),
    "secret-e": '{"kind":"openai_compatible"}',
    ...Object.fromEntries(Object.entries(more).map(([id, secret]) => [`secret-${id}`, secret])),
  };
  return {
    prisma: {
      userModelCredential: {
        findMany: vi.fn(async () =>
          ["a", "b", "c", "d", "e", ...Object.keys(more)].map((id) => ({
            id,
            secretId: `secret-${id}`,
          })),
        ),
      },
      secret: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          secrets[where.id] ? { id: where.id, ciphertext: `sealed-${where.id}` } : null,
        ),
      },
    },
    secretStore: { load: vi.fn(async (_ciphertext: string, id: string) => secrets[id]) },
  } as never;
}

const run = { userId: USER, modelPinned: false };
const selected = (id = "a") => ({ provider: "provider-a", id: MODEL, credential: credential(id) });

beforeEach(() => {
  db.pooled = new Map([
    ["a", null],
    ["b", null],
    ["c", null],
    ["d", null],
    ["e", null],
  ]);
  db.readModelPool
    .mockReset()
    .mockImplementation(async (_prisma, scope) =>
      scope.credentialIds
        .filter((id: string) => db.pooled.has(id))
        .map((id: string) => ({ credentialId: id, resetsAt: db.pooled.get(id) })),
    );
  db.findModelCredentialById
    .mockReset()
    .mockImplementation(async (_prisma, _scope, id: string) => credential(id));
  db.recordModelConnectionCooldown.mockReset().mockResolvedValue(true);
});

describe("loadRunModelPool", () => {
  it("has no pool for a connection that is not pooled, a pinned run or the deployment's model", async () => {
    db.pooled.delete("a");
    expect(await loadRunModelPool(deps(), run, selected(), now)).toBeUndefined();
    db.pooled.set("a", null);
    expect(
      await loadRunModelPool(deps(), { ...run, modelPinned: true }, selected(), now),
    ).toBeUndefined();
    expect(
      await loadRunModelPool(deps(), run, { ...selected(), credential: null }, now),
    ).toBeUndefined();
  });

  it("starts on the chosen connection with the other open connections after it", async () => {
    const pool = await loadRunModelPool(deps(), run, selected(), now);
    // c signs in with a subscription and joins; d and e cannot be read.
    expect(pool).toMatchObject({ credential: { id: "a" }, members: ["b", "c"] });
    expect(pool?.opensAt).toBeUndefined();
  });

  it("counts one subscription account once, however many connections signed in to it", async () => {
    db.pooled.set("f", null);
    db.pooled.set("g", null);
    const pool = await loadRunModelPool(
      deps({ f: signIn("account-1"), g: signIn("account-2") }),
      run,
      selected(),
      now,
    );
    expect(pool?.members).toEqual(["b", "c", "g"]);
  });

  it("leaves out a sign-in that must be made again, and starts past the chosen one when it is that", async () => {
    db.pooled.set("f", null);
    const dead = { f: signIn("account-2", true) };
    expect((await loadRunModelPool(deps(dead), run, selected(), now))?.members).toEqual(["b", "c"]);
    const chosenDead = await loadRunModelPool(deps(dead), run, selected("f"), now);
    expect(chosenDead).toMatchObject({ credential: { id: "a" }, members: ["b", "c"] });
  });

  it("reads rests for each subscription's account", async () => {
    await loadRunModelPool(deps(), run, selected(), now);
    const last = db.readModelPool.mock.calls.at(-1)?.[1];
    expect(last.credentialIds).toEqual(["a", "b", "c"]);
    expect([...last.accounts]).toEqual([["c", expect.stringMatching(/^account:[0-9a-f]{32}$/)]]);
    expect(JSON.stringify([...last.accounts])).not.toContain("account-1");
  });

  it("is no pool when the pool cannot be read", async () => {
    db.readModelPool.mockRejectedValue(new Error("relation does not exist"));
    expect(await loadRunModelPool(deps(), run, selected(), now)).toBeUndefined();
  });

  it("is no pool when only the chosen connection may join", async () => {
    db.pooled.delete("b");
    db.pooled.delete("c");
    expect(await loadRunModelPool(deps(), run, selected(), now)).toBeUndefined();
  });

  it("skips a connection that ran out until its reset, then takes it back", async () => {
    db.pooled.delete("c");
    db.pooled.set("a", new Date(now + HOUR));
    const resting = await loadRunModelPool(deps(), run, selected(), now);
    expect(resting).toMatchObject({ credential: { id: "b" }, members: [] });
    expect(db.findModelCredentialById).toHaveBeenCalledWith(
      expect.anything(),
      run,
      "b",
      "provider-a",
    );
    const reopened = await loadRunModelPool(deps(), run, selected(), now + HOUR);
    expect(reopened).toMatchObject({ credential: { id: "a" }, members: ["b"] });
  });

  it("tries only the connection that opens first when every one rests", async () => {
    db.pooled.delete("c");
    db.pooled.set("a", new Date(now + 2 * HOUR));
    db.pooled.set("b", new Date(now + HOUR));
    expect(await loadRunModelPool(deps(), run, selected(), now)).toMatchObject({
      credential: { id: "b" },
      members: [],
      opensAt: now + HOUR,
    });
  });

  it("stays on the chosen connection when the next one has gone meanwhile", async () => {
    db.pooled.set("a", new Date(now + HOUR));
    db.findModelCredentialById.mockResolvedValue(null);
    expect(await loadRunModelPool(deps(), run, selected(), now)).toMatchObject({
      credential: { id: "a" },
    });
  });

  it("rests a connection until the provider's reset, or the whole connection for a refused key", async () => {
    vi.useFakeTimers({ now });
    try {
      const pool = await loadRunModelPool(deps(), run, selected(), now);
      await pool?.recordOut("a", MODEL, "exhausted", now + 5 * HOUR);
      await pool?.recordOut("b", MODEL, "rejected");
      expect(db.recordModelConnectionCooldown.mock.calls.map(([, rest]) => rest)).toEqual([
        {
          userId: USER,
          credentialId: "a",
          modelId: MODEL,
          reason: "exhausted",
          resetsAt: new Date(now + 5 * HOUR),
          observedAt: new Date(now),
        },
        {
          userId: USER,
          credentialId: "b",
          modelId: null,
          reason: "rejected",
          // A refused key rests a few minutes first, longer only if refused again (the store).
          resetsAt: new Date(now + POOL_REFUSED_COOLDOWN_MS),
          observedAt: new Date(now),
        },
      ]);
      // A subscription that ran out rests for its account; a refused one only for this sign-in.
      await pool?.recordOut("c", MODEL, "exhausted");
      await pool?.recordOut("c", MODEL, "rejected");
      const [exhausted, rejected] = db.recordModelConnectionCooldown.mock.calls
        .slice(2)
        .map(([, rest]) => rest);
      expect(exhausted.holder).toMatch(/^account:[0-9a-f]{32}$/);
      expect(rejected).not.toHaveProperty("holder");
    } finally {
      vi.useRealTimers();
    }
  });
});

const pool = (members: string[]): RunModelPool => ({
  provider: "provider-a",
  modelId: MODEL,
  credential: credential("a"),
  members,
  recordOut: vi.fn(async () => true),
});

describe("withPoolMembers", () => {
  const backups = [
    { provider: "provider-a", modelId: MODEL, credentialId: "b" },
    { provider: "provider-z", modelId: "other" },
  ];
  const running = { provider: "provider-a", modelId: MODEL, connectionId: "a" };

  it("puts the pool's other connections first, each once", () => {
    expect(withPoolMembers(pool(["b", "c"]), running, "low", backups)).toEqual([
      { provider: "provider-a", modelId: MODEL, credentialId: "b", thinkingLevel: "low" },
      { provider: "provider-a", modelId: MODEL, credentialId: "c", thinkingLevel: "low" },
      { provider: "provider-z", modelId: "other" },
    ]);
  });

  it("leaves the backups alone without a pool, or for a run that started elsewhere", () => {
    expect(withPoolMembers(undefined, running, null, backups)).toBe(backups);
    expect(withPoolMembers(pool([]), running, null, backups)).toBe(backups);
    expect(withPoolMembers(pool(["b"]), { ...running, modelId: "other" }, null, backups)).toBe(
      backups,
    );
    expect(
      withPoolMembers(pool(["b"]), { ...running, provider: "provider-z" }, null, backups),
    ).toBe(backups);
    expect(withPoolMembers(pool(["b"]), { ...running, connectionId: "b" }, null, backups)).toBe(
      backups,
    );
  });
});

const failure = (errorMessage: string) => ({ errorMessage }) as AssistantMessage;

describe("connectionOutReason", () => {
  it("tells a connection that ran out from a failure that clears on its own", () => {
    expect(connectionOutReason(failure("402 Insufficient credits. Add more credits."))).toBe(
      "exhausted",
    );
    expect(connectionOutReason(failure("401 invalid_api_key"))).toBe("rejected");
    expect(connectionOutReason(failure("429 Rate limit reached: 60 requests per minute"))).toBe(
      undefined,
    );
    expect(connectionOutReason(failure("503 Service unavailable"))).toBeUndefined();
    // A limit that names billing but neither says it is spent nor gives a far reset is short.
    expect(
      connectionOutReason(failure("429 Rate limit reached. See billing for your limits.")),
    ).toBeUndefined();
    expect(connectionOutReason(failure('429 Limit reached {"retry-after":"7200"}'))).toBe(
      "exhausted",
    );
  });
});

describe("poolResetAt", () => {
  it("reads a subscription window's reset in words, after the provider's reset headers", () => {
    expect(
      poolResetAt("You have hit your ChatGPT usage limit (plus plan). Try again in ~90 min.", now),
    ).toBe(now + 90 * 60_000);
    expect(poolResetAt("Usage limit reached. Try again in 3 hours.", now)).toBe(now + 3 * HOUR);
    expect(poolResetAt("Weekly limit reached, try again in 2 days", now)).toBe(now + 48 * HOUR);
    expect(poolResetAt('429 {"retry-after":"7200"} Try again in 5 min', now)).toBe(now + 2 * HOUR);
    expect(poolResetAt("402 Insufficient credits.", now)).toBeUndefined();
  });
});

describe("switchAfterFailure and skipsPoolMember", () => {
  const request = () => ({ runId: "run" }) as unknown as AgentRunRequest;

  it("rests the connection that ran out and lets the pool take the call", async () => {
    const runPool = pool(["b"]);
    const state = { request: withRunModelPool(request(), runPool), nextIndex: 1 };
    const seen: boolean[] = [];
    const switched = await switchAfterFailure(
      state,
      { id: MODEL, connectionId: "a" },
      failure('429 quota exceeded {"x-ratelimit-reset":"4102444800"}'),
      async () => {
        seen.push(skipsPoolMember(state, { connectionId: "b" }));
        return true;
      },
    );
    expect(switched).toBe(true);
    expect(seen).toEqual([false]);
    expect(runPool.recordOut).toHaveBeenCalledWith("a", MODEL, "exhausted", 4_102_444_800_000);
    // The next failure is judged on its own.
    expect(skipsPoolMember(state, { connectionId: "b" })).toBe(true);
  });

  it("rests a subscription whose usage window ran out until the window resets", async () => {
    vi.useFakeTimers({ now });
    try {
      const runPool = pool(["b"]);
      const state = { request: withRunModelPool(request(), runPool), nextIndex: 1 };
      const switched = await switchAfterFailure(
        state,
        { id: MODEL, connectionId: "a" },
        failure("You have hit your ChatGPT usage limit (plus plan). Try again in ~90 min."),
        async () => true,
      );
      expect(switched).toBe(true);
      expect(runPool.recordOut).toHaveBeenCalledWith("a", MODEL, "exhausted", now + 90 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves on from a sign-in that must be made again, resting the whole connection", async () => {
    const runPool = pool(["b"]);
    const state = { request: withRunModelPool(request(), runPool), nextIndex: 1 };
    await switchAfterFailure(
      state,
      { id: MODEL, connectionId: "a" },
      failure(OAUTH_RECONNECT_REQUIRED_ERROR),
      async () => true,
    );
    expect(runPool.recordOut).toHaveBeenCalledWith("a", MODEL, "rejected", undefined);
  });

  it("passes the pool over after a failure that clears on its own", async () => {
    const runPool = pool(["b"]);
    const state = { request: withRunModelPool(request(), runPool), nextIndex: 1 };
    const seen: boolean[] = [];
    await switchAfterFailure(state, { id: MODEL, connectionId: "a" }, failure("503"), async () => {
      seen.push(skipsPoolMember(state, { connectionId: "b" }));
      return false;
    });
    expect(seen).toEqual([true]);
    expect(runPool.recordOut).not.toHaveBeenCalled();
    expect(skipsPoolMember(state, { connectionId: "z" })).toBe(false);
    expect(skipsPoolMember(state, {})).toBe(false);
  });

  it("goes back to a pool connection it passed over once the connection runs out", async () => {
    const runPool = pool(["b", "c"]);
    const state = { request: withRunModelPool(request(), runPool), nextIndex: 0 };
    // A short failure takes b and c from the chain and passes both over.
    await switchAfterFailure(state, { id: MODEL, connectionId: "a" }, failure("503"), async () => {
      for (const connectionId of ["b", "c"]) {
        state.nextIndex += 1;
        expect(skipsPoolMember(state, { connectionId })).toBe(true);
      }
      return false;
    });
    expect(state.nextIndex).toBe(2);
    await switchAfterFailure(
      state,
      { id: MODEL, connectionId: "a" },
      failure("402 Insufficient credits"),
      async () => {
        expect(state.nextIndex).toBe(0);
        return true;
      },
    );
  });

  it("changes nothing for a run without a pool", async () => {
    const state = { request: withRunModelPool(request(), undefined), nextIndex: 1 };
    const next = vi.fn(async () => true);
    expect(
      await switchAfterFailure(state, { id: MODEL }, failure("402 insufficient credits"), next),
    ).toBe(true);
    expect(next).toHaveBeenCalledOnce();
    expect(skipsPoolMember(state, { connectionId: "b" })).toBe(false);
  });

  it("moves on without a record for a failed call that names no connection", async () => {
    const runPool = pool(["b"]);
    const state = { request: withRunModelPool(request(), runPool), nextIndex: 1 };
    await switchAfterFailure(
      state,
      { id: MODEL },
      failure("401 invalid_api_key"),
      async () => true,
    );
    expect(runPool.recordOut).not.toHaveBeenCalled();
  });
});
