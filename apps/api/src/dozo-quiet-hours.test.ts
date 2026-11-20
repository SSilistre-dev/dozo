import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoQuietHoursRoutes } from "./dozo-quiet-hours.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const stored = vi.hoisted(() => new Map<string, { startMinute: number; endMinute: number }>());

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/adapters")>()),
  readDozoQuietHours: async (_prisma: unknown, userId: string) => stored.get(userId) ?? null,
  saveDozoQuietHours: async (
    _deps: unknown,
    userId: string,
    hours: { startMinute: number; endMinute: number } | null,
  ) => {
    if (hours) stored.set(userId, hours);
    else stored.delete(userId);
  },
}));

const NIGHT = { startMinute: 22 * 60, endMinute: 7 * 60 };

function client(userId: string | null) {
  const ctx = createRouterContext({
    prisma: { space: { findUnique: async () => null } },
    events: { notify: () => undefined, publishSpaceChange: () => undefined },
    env: {},
  } as unknown as RouterDeps);
  return createRouterClient(dozoQuietHoursRoutes(ctx), {
    context: {
      actor: userId
        ? { userId, spaceId: `space-${userId}`, email: `${userId}@example.test`, isDeploymentOwner: false }
        : null,
    },
  }).dozoQuietHours;
}

describe("quiet hours routes", () => {
  beforeEach(() => stored.clear());

  it("save and read the caller's own hours only", async () => {
    expect(await client("ada").get()).toEqual({ hours: null });
    expect(await client("ada").set({ hours: NIGHT })).toEqual({ hours: NIGHT });
    expect(await client("ada").get()).toEqual({ hours: NIGHT });
    expect(await client("eve").get()).toEqual({ hours: null });
    expect(await client("ada").set({ hours: null })).toEqual({ hours: null });
    expect(await client("ada").get()).toEqual({ hours: null });
  });

  it("refuse a range that starts where it ends, or a minute past the day", async () => {
    await expect(
      client("ada").set({ hours: { startMinute: 60, endMinute: 60 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client("ada").set({ hours: { startMinute: 0, endMinute: 1440 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(stored.size).toBe(0);
  });

  it("refuse a caller who is not signed in", async () => {
    await expect(client(null).get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
