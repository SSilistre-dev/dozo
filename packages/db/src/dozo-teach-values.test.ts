import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TeachRecordingEvent } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { isCiphertext } from "./content-crypto.js";
import {
  cacheTeachSuggestions,
  expireAllTeachValues,
  expireTeachValues,
  forgetTeachImage,
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
  it("seals the values past row security, queues their expiry and returns the recording with none left", async () => {
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
      snapshots: [
        { at, summary: "hunter2 - Search - Browser" },
        { at, summary: "hunter2" },
      ],
      dozoSuggestions: { "{{value 1}}": { name: "x" } },
    });
    expect(kept).toEqual({
      events: [
        { at, kind: "key", typed: true },
        { at, kind: "key", key: "Tab" },
        { at, kind: "key", typed: true, sensitive: true },
      ],
      snapshots: [{ at, summary: "Browser" }],
      dozoScrubbed: true,
    });
    // Whoever ends the recording, the row is written for the teacher with the bypass on.
    const bypass = calls.findIndex((call) => call.sql.includes("'app.rls_bypass', 'on'"));
    const insertAt = calls.findIndex((call) => call.sql.includes("INSERT"));
    expect(bypass).toBeGreaterThanOrEqual(0);
    expect(bypass).toBeLessThan(insertAt);
    const insert = calls[insertAt]!;
    expect(insert.params.slice(0, 3)).toEqual(["skill-1", "space-1", "ada"]);
    expect(isCiphertext(insert.params[3])).toBe(true);
    expect(String(insert.params[3])).not.toContain("hunter2");
    // No click, so no pictures.
    expect(insert.params[4]).toBeNull();
    expect(insert.params[5]).toBe(86_400);
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
    await keepTeachValues(db as never, skill, { events, snapshots: [] });
    const insert = calls.find((call) => call.sql.includes("INSERT"))!;
    expect(JSON.parse(String(insert.params[3]))).toHaveLength(2);
    expect(calls.some((call) => call.sql.includes("add_job"))).toBe(false);
  });

  it("moves the clicks' pictures to the store, none before protected input", async () => {
    const { db, calls } = client(
      (sql) => (sql.includes("INSERT") ? [{ expiresAt }] : [{ ready: false }]),
      ring,
    );
    // Clicks at 0, 9 (before the protected paste) and 11.
    const clicked: TeachRecordingEvent[] = [
      { at, kind: "pointer", x: 1, y: 1, type: "click" },
      ...events.slice(0, 8),
      { at, kind: "pointer", x: 2, y: 2, type: "click" },
      events[8]!,
      { at, kind: "pointer", x: 3, y: 3, type: "click" },
    ];
    const kept = await keepTeachValues(db as never, skill, {
      events: clicked,
      snapshots: [],
      dozoTargets: [
        { eventIndex: 0, window: "ali@example.test - Search - Browser", image: "AAAA" },
        // The click before the protected paste: its picture is never kept.
        { eventIndex: 9, image: "BBBB" },
        // A title without an application name is not kept at all.
        { eventIndex: 11, window: "hunter2", image: "CCCC" },
        // An event that is not a click any more once typing is collapsed.
        { eventIndex: 3, image: "DDDD" },
      ],
    });
    // Each typed run collapses to one event, so the clicks move to 0, 3 and 5.
    expect(kept).toEqual({
      events: [
        clicked[0],
        { at, kind: "key", typed: true },
        { at, kind: "key", key: "Tab" },
        clicked[9],
        { at, kind: "key", typed: true, sensitive: true },
        clicked[11],
      ],
      snapshots: [],
      dozoScrubbed: true,
      dozoTargets: [{ eventIndex: 0, window: "Browser" }, { eventIndex: 3 }, { eventIndex: 5 }],
    });
    expect(JSON.stringify(kept)).not.toMatch(/AAAA|BBBB|CCCC|DDDD|hunter2|ali@/);
    const insert = calls.find((call) => call.sql.includes("INSERT"))!;
    expect(isCiphertext(insert.params[4])).toBe(true);
    const stored = client(() => [
      {
        skillId: "skill-1",
        spaceId: "space-1",
        userId: "ada",
        values: insert.params[3],
        targets: insert.params[4],
        suggestions: null,
      },
    ]);
    const read = await readTeachValues(
      { ...stored.db, $contentEncryption: () => ({ ring }) } as never,
      "skill-1",
    );
    expect(read?.images).toEqual([
      { eventIndex: 0, image: "AAAA" },
      { eventIndex: 5, image: "CCCC" },
    ]);
  });

  it("leaves the clicks of a recording already forgotten where they are", async () => {
    const { db } = client((sql) => (sql.includes("INSERT") ? [{ expiresAt }] : [{ ready: false }]));
    const pointer: TeachRecordingEvent = { at, kind: "pointer", x: 1, y: 1, type: "click" };
    const marker = { at, kind: "key", typed: true } as TeachRecordingEvent;
    const kept = await keepTeachValues(db as never, skill, {
      events: [marker, pointer],
      snapshots: [],
      dozoScrubbed: true,
      dozoTargets: [{ eventIndex: 1, window: "Mail" }],
    });
    expect(kept).toMatchObject({ dozoTargets: [{ eventIndex: 1 }] });
  });

  it("keeps a row for pictures alone, with no values", async () => {
    const { db, calls } = client((sql) =>
      sql.includes("INSERT") ? [{ expiresAt }] : [{ ready: false }],
    );
    const pointer: TeachRecordingEvent = { at, kind: "pointer", x: 1, y: 1, type: "click" };
    expect(
      await keepTeachValues(db as never, skill, {
        events: [pointer],
        snapshots: [],
        dozoTargets: [{ eventIndex: 0, image: "AAAA" }],
      }),
    ).toEqual({
      events: [pointer],
      snapshots: [],
      dozoScrubbed: true,
      dozoTargets: [{ eventIndex: 0 }],
    });
    const insert = calls.find((call) => call.sql.includes("INSERT"))!;
    expect(insert.params[3]).toBe("[]");
    expect(JSON.parse(String(insert.params[4]))).toEqual([{ eventIndex: 0, image: "AAAA" }]);
  });

  it("stores nothing when nothing was typed", async () => {
    const { db, calls } = client();
    const pointer: TeachRecordingEvent = { at, kind: "pointer", x: 1, y: 1 };
    expect(await keepTeachValues(db as never, skill, { events: [pointer], snapshots: [] })).toEqual(
      { events: [pointer], snapshots: [], dozoScrubbed: true },
    );
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
    await keepTeachValues(db as never, skill, { events: events.slice(0, 7), snapshots: [] });
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
      images: [],
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
    // Pictures in another shape are dropped: the clicks keep their window and coordinate.
    const oddImages = client(() => [
      row({ values: JSON.stringify(values), targets: '[{"eventIndex":"x"}]' }),
    ]);
    expect((await readTeachValues(oddImages.db as never, "skill-1"))?.images).toEqual([]);
  });

  it("takes the values in the save's transaction past row security, unless they are due", async () => {
    const live = client(() => [row({ values: JSON.stringify(values), due: false })]);
    expect((await takeTeachValues(live.db as never, "skill-1"))?.values).toEqual(values);
    const sqls = live.calls.map((call) => call.sql);
    const deleted = sqls.findIndex((sql) => sql.includes("DELETE"));
    expect(sqls.findIndex((sql) => sql.includes("'app.rls_bypass', 'on'"))).toBe(deleted - 1);
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

describe("expireAllTeachValues", () => {
  it("deletes every due row", async () => {
    const { db, calls } = client();
    await expireAllTeachValues(db as never);
    expect(calls).toEqual([
      { sql: expect.stringContaining('"expiresAt" <= CURRENT_TIMESTAMP'), params: [] },
    ]);
    expect(calls[0]?.sql).not.toContain('"skillId"');
  });
});

describe("forgetTeachImage", () => {
  const row = (targets: string | null) => ({
    skillId: "skill-1",
    spaceId: "space-1",
    userId: "ada",
    values: "[]",
    targets,
    suggestions: null,
  });
  const pictures = JSON.stringify([
    { eventIndex: 0, image: "AAAA" },
    { eventIndex: 3, image: "BBBB" },
  ]);
  function prisma(stored: ReturnType<typeof row> | null) {
    const inner = client((sql) => (sql.includes("FOR UPDATE") && stored ? [stored] : []), ring);
    const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(inner.db));
    return { ...inner, prisma: { $transaction: transaction } };
  }

  it("forgets one picture at once, sealed again under the teacher's row lock", async () => {
    const { prisma: db, calls } = prisma(row(pictures));
    await forgetTeachImage(db as never, { id: "skill-1", userId: "ada" }, 3);
    expect(calls[0]?.sql).toContain("FOR UPDATE");
    expect(calls[0]?.sql).toContain('"userId" = ?');
    expect(calls[0]?.params).toEqual(["skill-1", "ada"]);
    const update = calls.find((call) => call.sql.includes('SET "targets"'));
    const sealed = update?.params[0] as string;
    expect(isCiphertext(sealed)).toBe(true);
    expect(sealed).not.toContain("BBBB");
    // Read back, only the other picture is left.
    const read = client(() => [row(sealed)], ring);
    expect((await readTeachValues(read.db as never, "skill-1"))?.images).toEqual([
      { eventIndex: 0, image: "AAAA" },
    ]);
  });

  it("leaves no column once the last picture goes, and is idempotent", async () => {
    const last = prisma(row(JSON.stringify([{ eventIndex: 3, image: "BBBB" }])));
    await forgetTeachImage(last.prisma as never, { id: "skill-1", userId: "ada" }, 3);
    expect(last.calls.find((call) => call.sql.includes('SET "targets"'))?.params[0]).toBeNull();
    for (const stored of [row(pictures), row(null), null]) {
      const again = prisma(stored);
      await forgetTeachImage(again.prisma as never, { id: "skill-1", userId: "ada" }, 7);
      expect(again.calls.some((call) => call.sql.includes('SET "targets"'))).toBe(false);
    }
  });
});

describe("the pictures' migration", () => {
  it("adds their column after the values store, and drops pictures older drafts kept", () => {
    const sql = readFileSync(
      new URL(
        "../prisma/migrations/20261230120200_dozo_teach_targets/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain('ADD COLUMN "targets" TEXT');
    expect(sql).toContain("- 'dozoTargets'");
  });
});
