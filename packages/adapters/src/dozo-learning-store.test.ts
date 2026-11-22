import { describe, expect, it, vi } from "vitest";
import {
  consumeLearningTurns,
  findLearningChange,
  learnedLines,
  learningMode,
  listLearningChanges,
  markLearningChangeUndone,
  pendingLearningTurns,
  recordLearningTurn,
  saveLearningChanges,
  setLearningMode,
} from "./dozo-learning-store.js";

// What each call sends and how it reads the answer. The SQL's results in every database time zone
// are covered by dozo-learning.postgres.test.ts.

const sqlOf = (call: unknown[]) => (call[0] as string[]).join("?").replace(/\s+/g, " ");

function db(rows: unknown[] = [], changed = 1) {
  const queryRaw = vi.fn(async (..._call: unknown[]) => rows);
  const executeRaw = vi.fn(async (..._call: unknown[]) => changed);
  const sql = () => [...queryRaw.mock.calls, ...executeRaw.mock.calls].map(sqlOf);
  return { client: { $queryRaw: queryRaw, $executeRaw: executeRaw }, queryRaw, executeRaw, sql };
}

const turn = { id: "t1", threadId: "th", runId: "r1", messageId: "m1", tainted: false };
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
    expect(await recordLearningTurn(db().client, { botId: "b", spaceId: "s", ...turn })).toBe(0);
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
    await saveLearningChanges(store.client, { id: "bot-1", spaceId: "s" }, "th", [
      { kind: "add", before: null, after: "a" },
      { kind: "remove", before: "b", after: null },
    ]);
    const [first, , second] = store.executeRaw.mock.calls;
    const time = (call: unknown[]) => Date.parse(call.at(-1) as string);
    expect(time(second!) - time(first!)).toBe(1);
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
    ).toEqual({ ...shown, undoneAt: at.toISOString(), supersededBy: "c2" });
    expect(await findLearningChange(db().client, "s", "c1")).toBeUndefined();
  });

  it("marks a change undone once", async () => {
    const undone = db([], 1);
    expect(await markLearningChangeUndone(undone.client, "c1")).toBe(true);
    // The change it took a line over from owns that line again.
    expect(undone.sql()[1]).toContain('SET "supersededBy" = NULL');
    expect(await markLearningChangeUndone(db([], 0).client, "c1")).toBe(false);
  });
});
