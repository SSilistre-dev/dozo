import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoLearningRoutes } from "./dozo-learning.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

// Who may read, switch and undo a bot's learning. What a review and an undo do is covered in
// packages/adapters (dozo-learning-review.test.ts); the SQL in dozo-learning.postgres.test.ts.

const state = vi.hoisted(() => ({
  mode: "off" as string,
  set: [] as Array<{ botId: string; mode: string }>,
  undone: [] as string[],
}));
const CHANGE = {
  id: "c1",
  kind: "add" as const,
  before: null,
  after: "Call the owner Ada.",
  createdAt: "2027-01-16T12:00:00.000Z",
  undoneAt: null,
};

vi.mock("@rakazo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/adapters")>();
  return {
    ...actual,
    learningMode: async () => state.mode,
    listLearningChanges: async () => [CHANGE],
    setLearningMode: async (_db: unknown, bot: { id: string }, mode: string) => {
      state.set.push({ botId: bot.id, mode });
    },
    undoLearningChange: async (
      _deps: unknown,
      _actor: unknown,
      changeId: string,
      checkBot: (botId: string) => Promise<unknown>,
    ) => {
      await checkBot("bot-1");
      state.undone.push(changeId);
      return { ...CHANGE, undoneAt: "2027-01-16T13:00:00.000Z" };
    },
  };
});

const bots: Record<string, { id: string; spaceId: string; userId: string }> = {
  "bot-1": { id: "bot-1", spaceId: "space", userId: "creator" },
};
const roles: Record<string, string> = { creator: "member", owner: "owner", member: "member" };

function client(userId: string) {
  const ctx = createRouterContext({
    prisma: {
      bot: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          bots[where.id] ? { ...bots[where.id], thread: null, computer: null } : null,
      },
      spaceMember: {
        findUnique: async ({ where }: { where: { spaceId_userId: { userId: string } } }) => ({
          role: roles[where.spaceId_userId.userId],
        }),
      },
    },
    events: { notify: () => undefined, publishSpaceChange: () => undefined },
    env: {},
  } as unknown as RouterDeps);
  return createRouterClient(dozoLearningRoutes(ctx), {
    context: {
      actor: {
        userId,
        spaceId: "space",
        email: `${userId}@example.test`,
        isDeploymentOwner: false,
      },
    },
  }).dozoLearning;
}

beforeEach(() => {
  state.mode = "off";
  state.set = [];
  state.undone = [];
});

describe("learning routes", () => {
  it("show a member the mode and the latest changes; a later phase's mode reads as off", async () => {
    expect(await client("member").get({ botId: "bot-1" })).toEqual({
      mode: "off",
      changes: [CHANGE],
    });
    state.mode = "auto";
    expect((await client("member").get({ botId: "bot-1" })).mode).toBe("auto");
    state.mode = "ask";
    expect((await client("member").get({ botId: "bot-1" })).mode).toBe("off");
    await expect(client("member").get({ botId: "elsewhere" })).rejects.toThrow();
  });

  it("let only the bot's creator or the space owner switch it", async () => {
    expect(await client("creator").setMode({ botId: "bot-1", mode: "auto" })).toEqual({
      mode: "auto",
    });
    expect(await client("owner").setMode({ botId: "bot-1", mode: "off" })).toEqual({
      mode: "off",
    });
    await expect(client("member").setMode({ botId: "bot-1", mode: "auto" })).rejects.toThrow();
    expect(state.set).toEqual([
      { botId: "bot-1", mode: "auto" },
      { botId: "bot-1", mode: "off" },
    ]);
  });

  it("refuse a mode this phase does not offer", async () => {
    await expect(
      client("creator").setMode({ botId: "bot-1", mode: "ask" as never }),
    ).rejects.toThrow();
    expect(state.set).toEqual([]);
  });

  it("let a member who sees the bot undo a change", async () => {
    expect(await client("member").undo({ changeId: "c1" })).toMatchObject({
      id: "c1",
      undoneAt: "2027-01-16T13:00:00.000Z",
    });
    expect(state.undone).toEqual(["c1"]);
  });
});
