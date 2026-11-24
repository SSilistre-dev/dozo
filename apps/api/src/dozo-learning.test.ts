import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoLearningRoutes } from "./dozo-learning.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

// Who may read, switch and undo a bot's learning. What a review and an undo do is covered in
// packages/adapters (dozo-learning-review.test.ts); the SQL in dozo-learning.postgres.test.ts.

const state = vi.hoisted(() => ({
  mode: "off" as string,
  alone: true,
  set: [] as Array<{ botId: string; mode: string }>,
  undone: [] as string[],
  settled: [] as string[],
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
    learningAvailable: async () => state.alone,
    settleLeftLearningWrites: async (_db: unknown, bot: { id: string }) => {
      state.settled.push(bot.id);
    },
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
  state.alone = true;
  state.set = [];
  state.undone = [];
  state.settled = [];
});

describe("learning routes", () => {
  it("show the bot's owner the mode, whether it is offered and the latest changes", async () => {
    expect(await client("creator").get({ botId: "bot-1" })).toEqual({
      mode: "off",
      available: true,
      changes: [CHANGE],
    });
    // A write a crash cut short is settled before the list is read.
    expect(state.settled).toEqual(["bot-1"]);
    state.mode = "auto";
    expect((await client("creator").get({ botId: "bot-1" })).mode).toBe("auto");
    state.mode = "ask";
    expect((await client("creator").get({ botId: "bot-1" })).mode).toBe("ask");
    await expect(client("creator").get({ botId: "elsewhere" })).rejects.toThrow();
  });

  it("show no one else what the bot learned from its owner's chat", async () => {
    for (const userId of ["member", "owner"]) {
      await expect(client(userId).get({ botId: "bot-1" })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    expect(state.settled).toEqual([]);
  });

  it("let only the bot's own owner switch it: their chat becomes notes every member reads", async () => {
    expect(await client("creator").setMode({ botId: "bot-1", mode: "auto" })).toEqual({
      mode: "auto",
    });
    await expect(client("owner").setMode({ botId: "bot-1", mode: "off" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(client("member").setMode({ botId: "bot-1", mode: "auto" })).rejects.toThrow();
    expect(state.set).toEqual([{ botId: "bot-1", mode: "auto" }]);
  });

  it("offer learning only in a Space of the owner's own; turning it off always works", async () => {
    state.alone = false;
    expect((await client("creator").get({ botId: "bot-1" })).available).toBe(false);
    await expect(client("creator").setMode({ botId: "bot-1", mode: "auto" })).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
    expect(await client("creator").setMode({ botId: "bot-1", mode: "off" })).toEqual({
      mode: "off",
    });
    expect(state.set).toEqual([{ botId: "bot-1", mode: "off" }]);
  });

  it("offer Ask to the owner as Auto is, only in a Space of their own, and refuse any other mode", async () => {
    expect(await client("creator").setMode({ botId: "bot-1", mode: "ask" })).toEqual({
      mode: "ask",
    });
    await expect(client("member").setMode({ botId: "bot-1", mode: "ask" })).rejects.toThrow();
    state.alone = false;
    await expect(client("creator").setMode({ botId: "bot-1", mode: "ask" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      client("creator").setMode({ botId: "bot-1", mode: "always" as never }),
    ).rejects.toThrow();
    expect(state.set).toEqual([{ botId: "bot-1", mode: "ask" }]);
  });

  it("let only the bot's owner undo a change", async () => {
    expect(await client("creator").undo({ changeId: "c1" })).toMatchObject({
      id: "c1",
      undoneAt: "2027-01-16T13:00:00.000Z",
    });
    expect(state.undone).toEqual(["c1"]);
    await expect(client("member").undo({ changeId: "c1" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(state.undone).toEqual(["c1"]);
  });
});
