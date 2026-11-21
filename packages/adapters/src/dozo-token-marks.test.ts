import { describe, expect, it, vi } from "vitest";
import type { DozoMarkDb } from "./dozo-token-marks.js";
import { dozoBotTokenTainted, dozoMarkBot, dozoMarkReached } from "./dozo-token-marks.js";

// What the SQL finds is covered against a real database in dozo-token-run.postgres.test.ts; these
// cover which question is asked and when a mark is written.

function db(sourced: boolean) {
  const queryRaw = vi.fn(async (..._call: unknown[]) => [{ sourced }]);
  const executeRaw = vi.fn(async (..._call: unknown[]) => 1);
  const client = { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as DozoMarkDb;
  return { client, queryRaw, executeRaw };
}

const run = { id: "run-1", botId: "bot-1", threadId: "thread-1", spaceId: "space-1" };

describe("dozoBotTokenTainted", () => {
  it("counts trust unless asked to ignore it", async () => {
    const { client, queryRaw } = db(true);
    expect(await dozoBotTokenTainted(client, run)).toBe(true);
    expect(await dozoBotTokenTainted(client, run, { ignoreTrust: true })).toBe(true);
    expect(queryRaw.mock.calls[0]).toContain(true);
    expect(queryRaw.mock.calls[1]).toContain(false);
    queryRaw.mockResolvedValueOnce([]);
    expect(await dozoBotTokenTainted(client, run)).toBe(false);
  });
});

describe("dozoMarkReached", () => {
  it("marks the bot text reached only when the sending run's bot is marked", async () => {
    const marked = db(true);
    await dozoMarkReached(marked.client, { run, targetBotId: "bot-2" });
    expect(marked.executeRaw).toHaveBeenCalledOnce();
    expect(marked.executeRaw.mock.calls[0]!.slice(1)).toEqual([
      "space-1",
      "run-1",
      "bot-2",
      "space-1",
    ]);
    const clean = db(false);
    await dozoMarkReached(clean.client, { run, targetBotId: "bot-2" });
    expect(clean.executeRaw).not.toHaveBeenCalled();
  });

  it("keeps one mark per bot and moves it to now when marked again", async () => {
    const { client, executeRaw } = db(true);
    await dozoMarkBot(client, { spaceId: "space-1", botId: "bot-2", fromRunId: "run-1" });
    const sql = (executeRaw.mock.calls[0]![0] as string[]).join("?");
    expect(sql).toContain('ON CONFLICT ("botId") WHERE NOT "lasting"');
    expect(sql).toContain('DO UPDATE SET "createdAt" = CURRENT_TIMESTAMP');
  });
});
