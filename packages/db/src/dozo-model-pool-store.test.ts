import { describe, expect, it, vi } from "vitest";
import {
  readModelPool,
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
      "model-1",
      "user-1",
      ["connection-a", "connection-b"],
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
      "rejected",
      rest.resetsAt,
      rest.observedAt,
      "connection-a",
      "user-1",
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
});
