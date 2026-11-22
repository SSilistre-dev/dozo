import { describe, expect, it, vi } from "vitest";
import {
  readModelPool,
  readModelPoolMembers,
  recordModelConnectionCooldown,
  setModelPoolMember,
} from "./dozo-model-pool-store.js";

// The SQL itself runs in dozo-model-pool-store.postgres.test.ts; this holds what each call sends
// and how it reads the answer, without a database.

function fakeDb(answers: { query?: unknown[]; execute?: number } = {}) {
  return {
    $queryRaw: vi.fn(
      async (_strings: TemplateStringsArray, ..._values: unknown[]) => answers.query ?? [],
    ),
    $executeRaw: vi.fn(
      async (_strings: TemplateStringsArray, ..._values: unknown[]) => answers.execute ?? 0,
    ),
  };
}

const owner = { userId: "user-1", credentialId: "connection-a" };

describe("setModelPoolMember", () => {
  it("takes a connection out of the pool", async () => {
    const db = fakeDb();
    expect(await setModelPoolMember(db as never, owner, false)).toBe(true);
    expect(db.$executeRaw.mock.calls[0]?.[0].join("?")).toContain("DELETE FROM");
    expect(db.$executeRaw.mock.calls[0]?.slice(1)).toEqual(["connection-a", "user-1"]);
  });

  it("adds the owner's connection", async () => {
    const db = fakeDb({ execute: 1 });
    expect(await setModelPoolMember(db as never, owner, true)).toBe(true);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("says whether a connection that added nothing was already pooled", async () => {
    expect(
      await setModelPoolMember(fakeDb({ query: [{ found: true }] }) as never, owner, true),
    ).toBe(true);
    expect(
      await setModelPoolMember(fakeDb({ query: [{ found: false }] }) as never, owner, true),
    ).toBe(false);
    expect(await setModelPoolMember(fakeDb({ query: [] }) as never, owner, true)).toBe(false);
  });
});

describe("readModelPool", () => {
  it("asks nothing for no connections", async () => {
    const db = fakeDb();
    expect(
      await readModelPool(db as never, { userId: "user-1", credentialIds: [], modelId: "m" }),
    ).toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("reads the given connections for the model and returns the rows", async () => {
    const rows = [{ credentialId: "connection-a", resetsAt: null }];
    const db = fakeDb({ query: rows });
    expect(
      await readModelPool(db as never, {
        userId: "user-1",
        credentialIds: ["connection-a", "connection-b"],
        modelId: "model-1",
      }),
    ).toBe(rows);
    expect(db.$queryRaw.mock.calls[0]?.slice(1)).toEqual([
      ["connection-a", "connection-b"],
      ["", ""],
      "model-1",
      "user-1",
    ]);
  });

  it("pairs each connection with its subscription account, '' for none", async () => {
    const db = fakeDb();
    await readModelPool(db as never, {
      userId: "user-1",
      credentialIds: ["connection-a", "connection-b"],
      modelId: "model-1",
      accounts: new Map([["connection-b", "account:abc"]]),
    });
    expect(db.$queryRaw.mock.calls[0]?.slice(1, 3)).toEqual([
      ["connection-a", "connection-b"],
      ["", "account:abc"],
    ]);
    expect(db.$queryRaw.mock.calls[0]?.[0].join("?")).toContain('cd."holder" = a."account"');
  });
});

describe("readModelPoolMembers", () => {
  it("asks nothing for no connections", async () => {
    const db = fakeDb();
    expect(
      await readModelPoolMembers(db as never, { userId: "user-1", credentialIds: [] }),
    ).toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("reads the given connections with a rest of any model", async () => {
    const rows = [{ credentialId: "connection-a", resetsAt: new Date("2026-11-20T13:00:00Z") }];
    const db = fakeDb({ query: rows });
    expect(
      await readModelPoolMembers(db as never, {
        userId: "user-1",
        credentialIds: ["connection-a", "connection-b"],
      }),
    ).toBe(rows);
    expect(db.$queryRaw.mock.calls[0]?.[0].join("?")).not.toContain('"modelId" IN');
    expect(db.$queryRaw.mock.calls[0]?.slice(1)).toEqual([
      ["connection-a", "connection-b"],
      ["", ""],
      "user-1",
    ]);
  });
});

describe("recordModelConnectionCooldown", () => {
  const rest = {
    userId: "user-1",
    credentialId: "connection-a",
    reason: "rejected" as const,
    resetsAt: new Date("2026-11-20T13:00:00Z"),
    observedAt: new Date("2026-11-20T12:00:00Z"),
  };

  it("rests the whole connection when no model is given", async () => {
    const db = fakeDb({ execute: 1 });
    expect(await recordModelConnectionCooldown(db as never, { ...rest, modelId: null })).toBe(true);
    expect(db.$executeRaw.mock.calls[0]?.slice(1)).toEqual([
      "",
      null,
      "rejected",
      // As instants with their zone, so a database in another zone stores the same moment.
      rest.resetsAt.toISOString(),
      rest.observedAt.toISOString(),
      "connection-a",
      "user-1",
      // How long a key refused again rests, and that a refusal while it rests changes nothing
      // (dozo-model-rests.postgres.test.ts).
      expect.objectContaining({ strings: [expect.stringContaining("'rejected'")] }),
      expect.objectContaining({ strings: [expect.stringContaining("NOT (")] }),
    ]);
  });

  it("says when nothing was written, as for a connection not pooled", async () => {
    const db = fakeDb({ execute: 0 });
    expect(
      await recordModelConnectionCooldown(db as never, {
        ...rest,
        modelId: "model-1",
        reason: "exhausted",
      }),
    ).toBe(false);
    expect(db.$executeRaw.mock.calls[0]?.[1]).toBe("model-1");
  });

  it("writes the account a subscription's rest belongs to", async () => {
    const db = fakeDb({ execute: 1 });
    await recordModelConnectionCooldown(db as never, {
      ...rest,
      modelId: "model-1",
      reason: "exhausted",
      holder: "account:abc",
    });
    expect(db.$executeRaw.mock.calls[0]?.slice(1, 4)).toEqual([
      "model-1",
      "account:abc",
      "exhausted",
    ]);
  });
});
