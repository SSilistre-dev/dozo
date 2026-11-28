import type { Actor } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { dozoBotStatsRoutes, dozoStatsShareKind, readBotStats } from "./dozo-bot-stats.js";
import type { RouterContext } from "./routes/context.js";

const actor = { userId: "user-me", spaceId: "space-1", email: "me@example.test" } as Actor;
const NUMBERS = { tasksFinished: 5, routineRuns: 2, skillsLearned: 1, daysActive: 3 };

/** Answers the bot lookup with `bot` and the numbers query with `numbers`, and keeps the SQL. */
function fakeDb(bot: { name: string; color: string } | null, numbers: unknown[] = [NUMBERS]) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const prisma = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim();
      statements.push({ text, values });
      return text.includes('SELECT "name"') ? (bot ? [bot] : []) : numbers;
    }),
  };
  return { prisma: prisma as never, statements };
}

describe("readBotStats", () => {
  it("reads the bot's numbers through its own id and Space, and counts UTC days", async () => {
    const { prisma, statements } = fakeDb(null);
    expect(await readBotStats(prisma, "space-1", "bot-1")).toEqual(NUMBERS);
    expect(statements[0]?.values).toContain("bot-1");
    expect(statements[0]?.text).toContain("AT TIME ZONE 'UTC'");
  });

  it("reads zeros when the query returns nothing", async () => {
    const { prisma } = fakeDb(null, []);
    expect(await readBotStats(prisma, "space-1", "bot-1")).toEqual({
      tasksFinished: 0,
      routineRuns: 0,
      skillsLearned: 0,
      daysActive: 0,
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
