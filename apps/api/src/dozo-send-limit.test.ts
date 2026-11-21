import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoSendLimitRoutes } from "./dozo-send-limit.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const stored = vi.hoisted(() => new Map<string, number>());

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  readDozoDailySends: async (_db: unknown, userId: string) => stored.get(userId) ?? 50,
  saveDozoDailySends: async (_db: unknown, userId: string, dailySends: number) => {
    stored.set(userId, dailySends);
  },
}));

function client(userId: string | null) {
  const ctx = createRouterContext({
    prisma: { space: { findUnique: async () => null } },
    events: { notify: () => undefined, publishSpaceChange: () => undefined },
    env: {},
  } as unknown as RouterDeps);
  return createRouterClient(dozoSendLimitRoutes(ctx), {
    context: {
      actor: userId
        ? {
            userId,
            spaceId: `space-${userId}`,
            email: `${userId}@example.test`,
            isDeploymentOwner: false,
          }
        : null,
    },
  }).dozoSendLimit;
}

describe("daily send limit routes", () => {
  beforeEach(() => stored.clear());

  it("save and read the caller's own number only", async () => {
    expect(await client("ada").get()).toEqual({ dailySends: 50 });
    expect(await client("ada").set({ dailySends: 10 })).toEqual({ dailySends: 10 });
    expect(await client("ada").get()).toEqual({ dailySends: 10 });
    expect(await client("eve").get()).toEqual({ dailySends: 50 });
  });

  it("refuse a number outside 1 to 1000, or no signed-in account", async () => {
    for (const dailySends of [0, 1001, 2.5])
      await expect(client("ada").set({ dailySends })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    await expect(client(null).get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(stored.size).toBe(0);
  });
});
