import { describe, expect, it, vi } from "vitest";
import {
  consumeLearningTurns,
  findLearningChange,
  LEARNING_TURNS_KEPT,
  learnedLines,
  learningMode,
  LEARNING_REVIEWS_PER_DAY,
  listLearningChanges,
  markLearningLinesOwnerEdited,
  markLearningUndoPending,
  pendingLearningTurns,
  pendingLearningWrites,
  recordLearningTurn,
  rejectedLearningLines,
  saveLearningChanges,
  setLearningMode,
  settleLearningWrite,
  takeLearningReview,
} from "./dozo-learning-store.js";

// What each call sends and how it reads the answer. The SQL's results in every database time zone
// are covered by dozo-learning.postgres.test.ts.

const sqlOf = (call: unknown[]) => (call[0] as string[]).join("?").replace(/\s+/g, " ");

// The store's own database parameter; the fake only has the two calls the store makes.
type StoreDb = Parameters<typeof learningMode>[0];

function db(rows: unknown[] = [], changed = 1) {
  const queryRaw = vi.fn(async (..._call: unknown[]) => rows);
  const executeRaw = vi.fn(async (..._call: unknown[]) => changed);
  const sql = () => [...queryRaw.mock.calls, ...executeRaw.mock.calls].map(sqlOf);
  const client = { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as StoreDb;
  return { client, queryRaw, executeRaw, sql };
}

const turn = { id: "t1", threadId: "th", runId: "r1", messageId: "m1", botReplyReadable: true };
const at = new Date("2027-01-16T12:00:00.000Z");
const row = {
  id: "c1",
  botId: "bot-1",
  kind: "add",
  before: null,
  after: "Prefers tea",
  createdAt: at,
  undoneAt: null,
};

describe("learning store", () => {
  it("reads a bot without a row as off", async () => {
    expect(await learningMode(db().client, "bot-1")).toBe("off");
    expect(await learningMode(db([{ mode: "auto" }]).client, "bot-1")).toBe("auto");
  });

  it("drops the waiting turns when learning is turned off, not when it is turned on", async () => {
    const on = db();
    await setLearningMode(on.client, { id: "bot-1", spaceId: "s" }, "auto");
    expect(on.sql()).toHaveLength(1);
    expect(on.executeRaw.mock.calls[0]!.slice(1)).toEqual(["bot-1", "s", "auto"]);
    const off = db();
    await setLearningMode(off.client, { id: "bot-1", spaceId: "s" }, "off");
    expect(off.sql()[1]).toContain("DELETE FROM dozo_learning_turns");
  });

  it("records a turn once per run and answers how many wait", async () => {
    const store = db([{ pending: 3 }]);
    const pending = await recordLearningTurn(store.client, {
      botId: "bot-1",
      spaceId: "s",
      ...turn,
    });
    expect(pending).toBe(3);
    expect(store.sql()[1]).toContain('ON CONFLICT ("runId") DO NOTHING');
    expect(store.executeRaw.mock.calls[0]!.at(-1)).toBe(true);
    expect(await recordLearningTurn(db().client, { botId: "b", spaceId: "s", ...turn })).toBe(0);
  });

  it("keeps only the newest waiting turns of the bot, so turns no review reads stay bounded", async () => {
    const store = db([{ pending: LEARNING_TURNS_KEPT }]);
    await recordLearningTurn(store.client, { botId: "bot-1", spaceId: "s", ...turn });
    const [insert, prune] = store.executeRaw.mock.calls.map(sqlOf);
    expect(LEARNING_TURNS_KEPT).toBe(100);
    expect(insert).toContain("INSERT INTO dozo_learning_turns");
    expect(prune).toContain("DELETE FROM dozo_learning_turns");
    expect(prune).toContain('ORDER BY "createdAt" DESC, id DESC LIMIT');
    expect(store.executeRaw.mock.calls[1]!.slice(1)).toEqual(["bot-1", "bot-1", 100]);
    // The count comes after the prune, so it never answers more than are kept.
    expect(sqlOf(store.queryRaw.mock.calls[0]!)).toContain("count(*)");
    expect(store.queryRaw.mock.invocationCallOrder[0]).toBeGreaterThan(
      store.executeRaw.mock.invocationCallOrder[1]!,
    );
  });

  it("reads the newest waiting turns oldest first, and consumes them with every older one", async () => {
    const store = db([turn]);
    expect(await pendingLearningTurns(store.client, "bot-1", 100)).toEqual([turn]);
    expect(store.queryRaw.mock.calls[0]!.slice(1)).toEqual(["bot-1", 100]);
    await consumeLearningTurns(store.client, "bot-1", [turn]);
    expect(store.executeRaw.mock.calls[0]!.slice(1)).toEqual(["bot-1", ["t1"], "t1"]);
    const empty = db();
    await consumeLearningTurns(empty.client, "bot-1", []);
    expect(empty.executeRaw).not.toHaveBeenCalled();
  });

  it("lists the review's own lines and keeps its changes in the order they were made", async () => {
    const lines = db([{ id: "c1", after: "x" }]);
    expect(await learnedLines(lines.client, "bot-1")).toEqual([{ id: "c1", after: "x" }]);
    expect(lines.sql()[0]).toContain('"supersededBy" IS NULL');
    const store = db();
    await saveLearningChanges(
      store.client,
      { id: "bot-1", spaceId: "s" },
      { threadId: "th", messageId: "m1" },
      [
        { kind: "add", before: null, after: "a" },
        { kind: "remove", before: "b", after: null },
      ],
      "tag-1",
    );
    const [first, , second] = store.executeRaw.mock.calls;
    const time = (call: unknown[]) => Date.parse(call.at(-2) as string);
    expect(time(second!) - time(first!)).toBe(1);
    // Pending under the write's tag until the write is settled.
    expect(first!.at(-1)).toBe("tag-1");
    expect(sqlOf(first!)).toContain("'apply'");
    expect(first!.slice(4, 6)).toEqual(["th", "m1"]);
    // Each change takes over the line it replaced or wrote from any older change.
    expect(store.sql()[1]).toContain('SET "supersededBy"');
    expect(store.executeRaw.mock.calls[1]!.slice(-3)).toEqual([null, "a", "bot-1"]);
    expect(store.sql()[4]).toContain("DELETE FROM dozo_learning_changes");
  });

  it("answers changes with their times as ISO strings", async () => {
    const shown = { ...row, createdAt: at.toISOString() };
    const { botId: _botId, ...listed } = shown;
    expect(await listLearningChanges(db([row]).client, "bot-1", 20)).toEqual([listed]);
    expect(
      await findLearningChange(
        db([{ ...row, undoneAt: at, supersededBy: "c2" }]).client,
        "s",
        "c1",
      ),
    ).toEqual({
      ...shown,
      undoneAt: at.toISOString(),
      supersededBy: "c2",
      ownerEdited: false,
      pending: null,
    });
    expect(
      await findLearningChange(
        db([{ ...row, ownerEditedAt: at, pending: "undo" }]).client,
        "s",
        "c1",
      ),
    ).toMatchObject({ supersededBy: null, ownerEdited: true, pending: "undo" });
    expect(await findLearningChange(db().client, "s", "c1")).toBeUndefined();
  });

  it("marks an undo pending once, only on a change neither undone nor pending", async () => {
    const undo = db([], 1);
    expect(await markLearningUndoPending(undo.client, "c1", "tag-1")).toBe(true);
    expect(undo.sql()[0]).toContain('"undoneAt" IS NULL AND pending IS NULL');
    expect(undo.executeRaw.mock.calls[0]!.slice(1)).toEqual(["tag-1", "c1"]);
    expect(await markLearningUndoPending(db([], 0).client, "c1", "tag-1")).toBe(false);
  });

  it("settles a write that landed: an undo is marked, its lines handed back", async () => {
    const landed = db([{ id: "c1" }]);
    await settleLearningWrite(landed.client, "tag-1", true);
    const sql = landed.sql();
    expect(sql[0]).toContain('SET "undoneAt" = CURRENT_TIMESTAMP');
    expect(sql[1]).toContain('SET "supersededBy" = NULL WHERE "supersededBy" = ?');
    expect(sql[2]).toContain('SET pending = NULL, "pendingTag" = NULL');
  });

  it("settles a write that did not land: a review's changes go, an undo stays undone-less", async () => {
    const lost = db([{ id: "c1" }, { id: "c2" }]);
    await settleLearningWrite(lost.client, "tag-1", false);
    const sql = lost.sql();
    expect(sql[0]).toContain("DELETE FROM dozo_learning_changes");
    expect(sql[0]).toContain("pending = 'apply'");
    expect(lost.executeRaw.mock.calls[0]!.slice(1)).toEqual([["c1", "c2"]]);
    expect(sql[2]).toContain('SET pending = NULL, "pendingTag" = NULL');
    const none = db([]);
    await settleLearningWrite(none.client, "tag-1", false);
    expect(none.executeRaw).toHaveBeenCalledOnce();
  });

  it("finds writes left pending: every review's when asked, any once old enough", async () => {
    const left = db([{ tag: "tag-1" }]);
    expect(
      await pendingLearningWrites(left.client, "bot-1", { reviews: true, olderThanMs: 300_000 }),
    ).toEqual(["tag-1"]);
    expect(left.queryRaw.mock.calls[0]!.slice(1)).toEqual(["bot-1", true, 300]);
  });

  it("gives a bot a bounded number of reviews a day", async () => {
    expect(LEARNING_REVIEWS_PER_DAY).toBe(6);
    const free = db([{ used: LEARNING_REVIEWS_PER_DAY - 1 }]);
    expect(await takeLearningReview(free.client, { id: "bot-1", spaceId: "s" })).toBe(true);
    const [prune, insert] = free.executeRaw.mock.calls.map(sqlOf);
    expect(prune).toContain("DELETE FROM dozo_learning_reviews");
    expect(prune).toContain("interval '1 day'");
    expect(insert).toContain("INSERT INTO dozo_learning_reviews");
    const used = db([{ used: LEARNING_REVIEWS_PER_DAY }]);
    expect(await takeLearningReview(used.client, { id: "bot-1", spaceId: "s" })).toBe(false);
    expect(used.executeRaw).toHaveBeenCalledOnce();
    expect(await takeLearningReview(db([]).client, { id: "bot-1", spaceId: "s" })).toBe(true);
  });

  it("reads the lines the owner turned down, and marks lines the owner edited", async () => {
    const rejected = db([{ after: "x" }]);
    expect(await rejectedLearningLines(rejected.client, "bot-1")).toEqual(["x"]);
    expect(rejected.sql()[0]).toContain('"ownerEditedAt" IS NOT NULL');
    const edited = db();
    await markLearningLinesOwnerEdited(edited.client, ["c1"]);
    expect(edited.executeRaw.mock.calls[0]!.slice(1)).toEqual([["c1"]]);
    const none = db();
    await markLearningLinesOwnerEdited(none.client, []);
    expect(none.executeRaw).not.toHaveBeenCalled();
  });
});
