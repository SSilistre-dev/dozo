import { createRouterClient } from "@orpc/server";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoDailyDigestRoutes } from "./dozo-daily-digest.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

type Saved = { botId: string; minute: number; spaceId: string };
const stored = vi.hoisted(() => new Map<string, Saved>());

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/adapters")>()),
  readDozoDailyDigest: async (_prisma: unknown, userId: string) => {
    const saved = stored.get(userId);
    return saved
      ? { botId: saved.botId, botName: `name-${saved.botId}`, minute: saved.minute }
      : null;
  },
  saveDozoDailyDigest: async (_deps: unknown, userId: string, digest: Saved | null) => {
    if (digest) stored.set(userId, digest);
    else stored.delete(userId);
  },
}));

// Bots by id: their Space, and whether they have a chat.
const BOTS: Record<string, { spaceId: string; thread: { id: string } | null }> = {
  "bot-1": { spaceId: "space-ada", thread: { id: "thread-1" } },
  "bot-silent": { spaceId: "space-ada", thread: null },
  "bot-other": { spaceId: "space-other", thread: { id: "thread-2" } },
};

function client(userId: string | null, spaceId = `space-${userId}`) {
  const ctx = createRouterContext({
    prisma: {
      space: { findUnique: async () => null },
      bot: {
        findFirst: async ({ where }: { where: { id: string; spaceId: string } }) => {
          const bot = BOTS[where.id];
          return bot && bot.spaceId === where.spaceId
            ? { id: where.id, ...bot, archivedAt: null, computer: null }
            : null;
        },
        findUnique: async ({ where }: { where: { id: string } }) =>
          BOTS[where.id] ? { spaceId: BOTS[where.id]?.spaceId } : null,
      },
    },
    events: { notify: () => undefined, publishSpaceChange: () => undefined },
    env: {},
  } as unknown as RouterDeps);
  return createRouterClient(dozoDailyDigestRoutes(ctx), {
    context: {
      actor: userId
        ? { userId, spaceId, email: `${userId}@example.test`, isDeploymentOwner: false }
        : null,
    },
  }).dozoDailyDigest;
}

describe("daily digest routes", () => {
  beforeEach(() => stored.clear());

  it("save and read the caller's own digest only", async () => {
    expect(await client("ada").get()).toEqual({ digest: null });
    expect(await client("ada").set({ digest: { botId: "bot-1", minute: 480 } })).toEqual({
      digest: { botId: "bot-1", botName: "name-bot-1", minute: 480 },
    });
    expect(stored.get("ada")?.spaceId).toBe("space-ada");
    expect(await client("eve").get()).toEqual({ digest: null });
    expect(await client("ada").set({ digest: null })).toEqual({ digest: null });
    expect(await client("ada").get()).toEqual({ digest: null });
  });

  // An IsolationError is answered as not found (rpc-errors.ts).
  it("refuse a bot outside the caller's Space or without a chat", async () => {
    await expect(
      client("ada").set({ digest: { botId: "bot-other", minute: 480 } }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      client("ada").set({ digest: { botId: "bot-silent", minute: 480 } }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(stored.size).toBe(0);
  });

  it("move the time of the bot it has from another Space", async () => {
    stored.set("ada", { botId: "bot-other", minute: 480, spaceId: "space-other" });
    await client("ada").set({ digest: { botId: "bot-other", minute: 600 } });
    expect(stored.get("ada")).toEqual({ botId: "bot-other", minute: 600, spaceId: "space-other" });
  });

  it("refuse its bot once that bot is gone", async () => {
    stored.set("ada", { botId: "bot-gone", minute: 480, spaceId: "space-ada" });
    await expect(
      client("ada").set({ digest: { botId: "bot-gone", minute: 600 } }),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("refuse a minute past the day", async () => {
    await expect(
      client("ada").set({ digest: { botId: "bot-1", minute: 1440 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuse a caller who is not signed in", async () => {
    await expect(client(null).get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
