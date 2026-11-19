import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TeachRecordingEvent } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { isCiphertext } from "./content-crypto.js";
import {
  cacheTeachSuggestions,
  expireTeachValues,
  keepTeachValues,
  readTeachValues,
  takeTeachValues,
} from "./dozo-teach-values.js";
import { JsonColumnMismatchError } from "./json-column.js";

const at = "2026-01-01T00:00:00.000Z";
const events: TeachRecordingEvent[] = [
  ...[..."hunter2"].map((key): TeachRecordingEvent => ({ at, kind: "key", key })),
  { at, kind: "key", key: "Tab" },
  { at, kind: "clipboard", sensitive: true },
];
const skill = { id: "skill-1", spaceId: "space-1", userId: "ada" };
const key = { id: "key-1", spaceId: "space-1", version: 1, key: randomBytes(32) };

type Call = { sql: string; params: unknown[] };

/** A client that records each statement and answers it from `answer`. */
function client(
  answer: (sql: string, params: unknown[]) => unknown[] = () => [],
  ring?: Record<string, unknown>,
) {
  const calls: Call[] = [];
  const run = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = strings.join("?");
    calls.push({ sql, params });
    return answer(sql, params);
  };
  return {
    calls,
    db: {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) =>
        run(strings, ...params),
      ),
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
        run(strings, ...params);
        return 1;
      }),
      ...(ring ? { $contentEncryption: () => ({ ring }) } : {}),
    },
  };
}

const ring = {
  encryptWrites: true,
  current: vi.fn(async () => key),
  byId: vi.fn(async () => key),
};
const expiresAt = new Date("2026-01-02T00:00:00.000Z");

describe("keepTeachValues", () => {
  it("seals the values, queues their expiry and returns the recording with none left", async () => {
    const { db, calls } = client(
      (sql) =>
        sql.includes("INSERT")
          ? [{ expiresAt }]
          : sql.includes("to_regnamespace")
            ? [{ ready: true }]
            : [],
      ring,
    );
    const kept = await keepTeachValues(db as never, skill, {
      events,
      snapshots: [],
      dozoSuggestions: { "{{value 1}}": { name: "x" } },
    });
    expect(kept).toEqual({
      events: [
        { at, kind: "key", typed: true },
        { at, kind: "key", key: "Tab" },
        { at, kind: "key", typed: true, sensitive: true },
      ],
      snapshots: [],
    });
    const insert = calls.find((call) => call.sql.includes("INSERT"))!;
    expect(insert.params.slice(0, 3)).toEqual(["skill-1", "space-1", "ada"]);
    expect(isCiphertext(insert.params[3])).toBe(true);
    expect(String(insert.params[3])).not.toContain("hunter2");
    expect(insert.params[4]).toBe(86_400);
    const job = calls.find((call) => call.sql.includes("add_job"))!;
    expect(job.params).toEqual([
      "skill.teaching-expire",
      '{"skillId":"skill-1"}',
      expiresAt.toISOString(),
      "dozo.teach-values:skill-1",
    ]);
  });

  it("stores plain text where encryption is off, and queues nothing without the queue", async () => {
    const { db, calls } = client((sql) =>
      sql.includes("INSERT")
        ? [{ expiresAt }]
        : sql.includes("to_regnamespace")
          ? [{ ready: false }]
          : [],
    );
    await keepTeachValues(db as never, skill, { events });
    const insert = calls.find((call) => call.sql.includes("INSERT"))!;
    expect(JSON.parse(String(insert.params[3]))).toHaveLength(2);
    expect(calls.some((call) => call.sql.includes("add_job"))).toBe(false);
  });

  it("stores nothing when nothing was typed", async () => {
    const { db, calls } = client();
    const pointer: TeachRecordingEvent = { at, kind: "pointer", x: 1, y: 1 };
    expect(await keepTeachValues(db as never, skill, { events: [pointer] })).toEqual({
      events: [pointer],
    });
    expect(calls).toEqual([]);
  });
});

describe("reading the values", () => {
  const values = [{ placeholder: "{{value 1}}", text: "hunter2", secret: false }];

  async function sealed() {
    const { db, calls } = client(
      (sql) => (sql.includes("INSERT") ? [{ expiresAt }] : [{ ready: false }]),
      ring,
    );
    await keepTeachValues(db as never, skill, { events: events.slice(0, 7) });
    return calls.find((call) => call.sql.includes("INSERT"))!.params[3] as string;
  }

  const row = (fields: Record<string, unknown>) => ({
    skillId: "skill-1",
    spaceId: "space-1",
    userId: "ada",
    suggestions: null,
    ...fields,
  });

  it("deletes a due row first, then opens the sealed values", async () => {
    const text = await sealed();
    const { db, calls } = client(
      (sql) => (sql.includes("SELECT") ? [row({ values: text })] : []),
      ring,
    );
    expect(await readTeachValues(db as never, "skill-1")).toEqual({
      userId: "ada",
      values,
      suggestions: null,
    });
    expect(calls[0]?.sql).toContain('"expiresAt" <= CURRENT_TIMESTAMP');
    expect(calls[0]?.sql).toContain("DELETE");
  });

  it("has nothing for a missing row, and refuses a row it cannot open or read", async () => {
    expect(await readTeachValues(client().db as never, "skill-1")).toBeNull();
    const text = await sealed();
    const noRing = client(() => [row({ values: text })]);
    await expect(readTeachValues(noRing.db as never, "skill-1")).rejects.toThrow(/unavailable/);
    const otherSpace = client(() => [row({ values: text, spaceId: "space-2" })], ring);
    await expect(readTeachValues(otherSpace.db as never, "skill-1")).rejects.toThrow(/mismatch/);
    const odd = client(() => [row({ values: '[{"placeholder":1}]' })]);
    await expect(readTeachValues(odd.db as never, "skill-1")).rejects.toBeInstanceOf(
      JsonColumnMismatchError,
    );
    // Suggestions in another shape are asked for again.
    const oddSuggestions = client(() => [
      row({ values: JSON.stringify(values), suggestions: { a: 1 } }),
    ]);
    expect((await readTeachValues(oddSuggestions.db as never, "skill-1"))?.suggestions).toBeNull();
  });

  it("takes the values in the save's transaction, unless they are due", async () => {
    const live = client(() => [row({ values: JSON.stringify(values), due: false })]);
    expect((await takeTeachValues(live.db as never, "skill-1"))?.values).toEqual(values);
    expect(live.calls[0]?.sql).toContain("DELETE");
    const due = client(() => [row({ values: JSON.stringify(values), due: true })]);
    expect(await takeTeachValues(due.db as never, "skill-1")).toBeNull();
    expect(await takeTeachValues(client().db as never, "skill-1")).toBeNull();
  });
});

describe("cacheTeachSuggestions", () => {
  it("keeps the first suggestions written, and has none once the values are gone", async () => {
    const first = { "{{value 1}}": { name: "login" } };
    const { db, calls } = client(() => [{ suggestions: first }]);
    expect(
      await cacheTeachSuggestions(db as never, "skill-1", { "{{value 1}}": { name: "x" } }),
    ).toEqual(first);
    expect(calls[0]?.sql).toContain("COALESCE");
    const odd = client(() => [{ suggestions: "odd" }]);
    expect(await cacheTeachSuggestions(odd.db as never, "skill-1", first)).toEqual(first);
    expect(await cacheTeachSuggestions(client().db as never, "skill-1", first)).toBeNull();
  });
});

describe("expireTeachValues", () => {
  it("deletes only a due row", async () => {
    const { db, calls } = client();
    await expireTeachValues(db as never, "skill-1");
    expect(calls).toEqual([
      { sql: expect.stringContaining('"expiresAt" <= CURRENT_TIMESTAMP'), params: ["skill-1"] },
    ]);
  });
});

describe("the migrations", () => {
  const migration = (name: string) =>
    readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url));

  // Prisma never runs a migration again once applied, whatever its file says now: an edit to an
  // applied one leaves a database without what the edit added (here the values table, so every
  // stop failed). Its checksum is pinned to what databases ran.
  it("never edits the scrub migration databases already applied", () => {
    const applied = createHash("sha256")
      .update(migration("20261230120000_dozo_teach_recording_scrub"))
      .digest("hex");
    expect(applied).toBe("f1ed3a45b6183a7fa522eeefb211d6dc4d91283a59b1f648c44446da879c0f2d");
  });

  it("creates the values store in a migration of its own, after it", () => {
    const sql = migration("20261230120100_dozo_teach_values").toString("utf8");
    expect(sql).toContain('CREATE TABLE "dozo_teach_values"');
  });
});
