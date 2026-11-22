import { describe, expect, it, vi } from "vitest";
import {
  endModelRests,
  readActiveModelRests,
  recordModelConnectionCooldown,
  recordModelRest,
} from "./dozo-model-pool-store.js";

// The SQL itself runs in dozo-model-rests.postgres.test.ts; this holds what each call sends and
// how it reads the answer, without a database.

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

const at = new Date("2026-11-22T10:00:00.000Z");
const until = new Date("2026-11-22T11:00:00.000Z");

describe("recordModelRest", () => {
  it("rests the owner's connection for a model, pooled or not, after clearing long-ended rests", async () => {
    const db = fakeDb({ execute: 1 });
    const rest = {
      userId: "user-1",
      credentialId: "connection-a",
      modelId: "model-a",
      reason: "exhausted" as const,
      resetsAt: until,
      observedAt: at,
    };
    expect(await recordModelRest(db as never, rest)).toBe(true);
    const [cleared, ...clearValues] = db.$executeRaw.mock.calls[0]!;
    expect(cleared.join("?")).toContain("DELETE FROM");
    expect(cleared.join("?")).toContain("interval '24 hours'");
    expect(clearValues).toEqual(["user-1", at.toISOString()]);
    const [strings, ...values] = db.$executeRaw.mock.calls[1]!;
    expect(strings.join("?")).toContain('FROM "user_model_credentials" c');
    expect(strings.join("?")).not.toContain("dozo_model_pool_members");
    expect(values.filter((value) => typeof value === "string")).toEqual([
      "model-a",
      "exhausted",
      until.toISOString(),
      at.toISOString(),
      "connection-a",
      "user-1",
    ]);
  });

  it("rests a key refused again on the same secret twice as long, in the pool's store too", async () => {
    for (const record of [recordModelRest, recordModelConnectionCooldown]) {
      const db = fakeDb({ execute: 1 });
      await record(db as never, {
        userId: "user-1",
        credentialId: "connection-a",
        modelId: null,
        reason: "rejected",
        resetsAt: until,
        observedAt: at,
      });
      const fragment = db.$executeRaw.mock.calls
        .at(-1)!
        .find((value): value is { strings: string[] } =>
          Boolean(value && typeof value === "object" && "strings" in value && "values" in value),
        );
      const sql = fragment?.strings.join("?") ?? "";
      expect(sql).toContain("2 * (");
      expect(sql).toContain("interval '168 hours'");
      expect(sql).toContain('"secretId" = EXCLUDED."secretId"');
    }
  });

  it("rests a whole connection whose key was refused, and says when nothing was written", async () => {
    const db = fakeDb({ execute: 0 });
    const rest = {
      userId: "user-1",
      credentialId: "not-theirs",
      modelId: null,
      reason: "rejected" as const,
      resetsAt: until,
      observedAt: at,
    };
    expect(await recordModelRest(db as never, rest)).toBe(false);
    expect(db.$executeRaw.mock.calls[1]?.[1]).toBe("");
  });
});

describe("readActiveModelRests", () => {
  it("reads the person's rests that have not ended and returns the rows", async () => {
    const rows = [{ credentialId: "connection-a", modelId: "model-a", resetsAt: until }];
    const db = fakeDb({ query: rows });
    expect(await readActiveModelRests(db as never, "user-1", at)).toEqual(rows);
    expect(db.$queryRaw.mock.calls[0]?.slice(1)).toEqual(["user-1", at.toISOString()]);
  });
});

describe("endModelRests", () => {
  it("ends the model's rests on the person's connections of its provider", async () => {
    const db = fakeDb({ execute: 2 });
    expect(
      await endModelRests(db as never, {
        userId: "user-1",
        providers: ["provider-a", "provider-a-old"],
        modelId: "model-a",
      }),
    ).toBe(2);
    expect(db.$executeRaw.mock.calls[0]?.slice(1)).toEqual([
      "user-1",
      ["provider-a", "provider-a-old"],
      "model-a",
    ]);
  });
});
