import type { Actor } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  createStatsShareKind,
  dozoBotStatsRoutes,
  dozoStatsShareKind,
  readBotStats,
  STATS_CARD_CACHE_MS,
  STATS_RUN_WINDOW,
} from "./dozo-bot-stats.js";
import type { RouterContext } from "./routes/context.js";

const actor = { userId: "user-me", spaceId: "space-1", email: "me@example.test" } as Actor;
const RUNS = { scanned: 40, tasksFinished: 5, routineRuns: 2, daysActive: 3 };
const NUMBERS = { tasksFinished: 5, routineRuns: 2, skillsLearned: 1, daysActive: 3, more: false };

/** Answers the bot lookup with `bot` and the numbers query with `numbers`, and keeps the SQL. */
function fakeDb(bot: { name: string; color: string } | null, numbers: unknown[] = [RUNS]) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const prisma = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim();
      statements.push({ text, values });
      if (text.includes('SELECT "name"')) return bot ? [bot] : [];
      return text.includes("FROM taught_skills") ? [{ skillsLearned: 1 }] : numbers;
    }),
  };
  return { prisma: prisma as never, statements };
}

describe("readBotStats", () => {
  const member = { spaceId: "space-1", userId: "user-me" };

  it("counts for the owner in the bot's own Space, over UTC days and a bounded window", async () => {
    const { prisma, statements } = fakeDb(null);
    expect(await readBotStats(prisma, member, "bot-1")).toEqual(NUMBERS);
    const [runs] = statements;
    expect(runs?.values).toEqual(expect.arrayContaining(["bot-1", "space-1", "user-me"]));
    expect(runs?.values).toContain(STATS_RUN_WINDOW + 1);
    expect(runs?.text).toContain("AT TIME ZONE 'UTC'");
  });

  it("says the numbers are at least that when the history runs past the window", async () => {
    const { prisma } = fakeDb(null, [{ ...RUNS, scanned: STATS_RUN_WINDOW + 1 }]);
    expect((await readBotStats(prisma, member, "bot-1")).more).toBe(true);
  });

  it("reads zeros when the query returns nothing", async () => {
    const { prisma } = fakeDb(null, []);
    expect(await readBotStats(prisma, member, "bot-1")).toEqual({
      tasksFinished: 0,
      routineRuns: 0,
      skillsLearned: 1,
      daysActive: 0,
      more: false,
    });
  });
});

describe("the stats share kind", () => {
  it("lets the owner share the bot, and asks for the owner's id", async () => {
    const { prisma, statements } = fakeDb({ name: "Pip", color: "#3b82f6" });
    expect(await dozoStatsShareKind.canShare(prisma, actor, "bot-1")).toBe(true);
    expect(statements[0]?.values).toContain("user-me");
  });

  it("refuses a bot that is not the maker's", async () => {
    const { prisma } = fakeDb(null);
    expect(await dozoStatsShareKind.canShare(prisma, actor, "bot-2")).toBe(false);
  });

  it("shows the name, the look and the numbers, and nothing else", async () => {
    const { prisma } = fakeDb({ name: "Pip", color: "#3b82f6" });
    const payload = await dozoStatsShareKind.load(prisma, {
      userId: "user-me",
      spaceId: "space-1",
      targetId: "bot-1",
    });
    expect(payload).toEqual({
      name: "Pip",
      character: expect.any(String),
      color: expect.stringMatching(/^#[0-9a-f]{6}$/),
      stats: NUMBERS,
    });
  });

  it("serves a card from memory for a few minutes, then reads it again", async () => {
    let clock = 0;
    const kind = createStatsShareKind(() => clock);
    const { prisma, statements } = fakeDb({ name: "Pip", color: "#3b82f6" });
    const link = { userId: "user-me", spaceId: "space-1", targetId: "bot-1" };
    await kind.load(prisma, link);
    const reads = statements.length;
    clock = STATS_CARD_CACHE_MS - 1;
    await kind.load(prisma, link);
    expect(statements).toHaveLength(reads);
    clock = STATS_CARD_CACHE_MS + 1;
    await kind.load(prisma, link);
    expect(statements.length).toBeGreaterThan(reads);
  });

  it("keeps a bounded number of cards", async () => {
    const kind = createStatsShareKind(() => 0);
    const { prisma, statements } = fakeDb({ name: "Pip", color: "#3b82f6" });
    for (let at = 0; at < 201; at++) {
      await kind.load(prisma, { userId: "u", spaceId: "s", targetId: `bot-${at}` });
    }
    const reads = statements.length;
    await kind.load(prisma, { userId: "u", spaceId: "s", targetId: "bot-0" });
    expect(statements.length).toBeGreaterThan(reads);
  });

  it("shows nothing for a bot that is gone", async () => {
    const { prisma } = fakeDb(null);
    expect(
      await dozoStatsShareKind.load(prisma, { userId: "u", spaceId: "s", targetId: "gone" }),
    ).toBeNull();
  });
});

describe("dozoBotStats/get", () => {
  const route = (bot: { name: string; color: string } | null) => {
    const { prisma } = fakeDb(bot);
    const ctx = {
      deps: { prisma },
      authed: { dozoBotStats: { get: { handler: (fn: unknown) => fn } } },
    } as unknown as RouterContext;
    return dozoBotStatsRoutes(ctx).dozoBotStats.get as unknown as (call: {
      context: { actor: Actor };
      input: { botId: string };
    }) => Promise<unknown>;
  };

  it("answers the owner and refuses anyone else as not found", async () => {
    const call = { context: { actor }, input: { botId: "bot-1" } };
    expect(await route({ name: "Pip", color: "#fff" })(call)).toEqual(NUMBERS);
    await expect(route(null)(call)).rejects.toBeInstanceOf(IsolationError);
  });
});
