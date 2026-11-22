import { describe, expect, it, vi } from "vitest";
import {
  endModelRests,
  hasModelRests,
  readModelRests,
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
  it("rests the owner's connection for a model, pooled or not", async () => {
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
    const [strings, ...values] = db.$executeRaw.mock.calls[0]!;
    expect(strings.join("?")).toContain('FROM "user_model_credentials" c');
    expect(strings.join("?")).not.toContain("dozo_model_pool_members");
    expect(values).toEqual([
      "model-a",
      "exhausted",
      until.toISOString(),
      at.toISOString(),
      "connection-a",
      "user-1",
    ]);
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
    expect(db.$executeRaw.mock.calls[0]?.[1]).toBe("");
  });
});

describe("readModelRests", () => {
  it("asks nothing for no models", async () => {
    const db = fakeDb();
    expect(await readModelRests(db as never, { userId: "user-1", models: [] })).toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("reads each model on its connection and returns the rows", async () => {
    const rows = [{ credentialId: "connection-a", modelId: "model-a", resetsAt: until }];
    const db = fakeDb({ query: rows });
    const models = [
      { credentialId: "connection-a", modelId: "model-a" },
      { credentialId: "connection-b", modelId: "model-b" },
    ];
    expect(await readModelRests(db as never, { userId: "user-1", models })).toEqual(rows);
    expect(db.$queryRaw.mock.calls[0]?.slice(1)).toEqual([
      ["connection-a", "connection-b"],
      ["model-a", "model-b"],
      "user-1",
    ]);
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

describe("hasModelRests", () => {
  it("says whether any rest of the person's is still running", async () => {
    expect(await hasModelRests(fakeDb({ query: [{ found: true }] }) as never, "user-1", at)).toBe(
      true,
    );
    const db = fakeDb({ query: [{ found: false }] });
    expect(await hasModelRests(db as never, "user-1", at)).toBe(false);
    expect(db.$queryRaw.mock.calls[0]?.slice(1)).toEqual(["user-1", at.toISOString()]);
    expect(await hasModelRests(fakeDb() as never, "user-1", at)).toBe(false);
  });
});
