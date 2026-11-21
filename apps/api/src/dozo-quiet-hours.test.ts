import { createRouterClient } from "@orpc/server";
import { DOZO_QUIET_DAYS } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoQuietHoursRoutes } from "./dozo-quiet-hours.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

type Range = { startMinute: number; endMinute: number; days: number };
const stored = vi.hoisted(() => new Map<string, Range[]>());
/** Who wrote at night, by account: the suggestion reads only the caller's own messages. */
const suggestions = vi.hoisted(() => new Map<string, Range[]>());

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/adapters")>()),
  readDozoQuietHours: async (_prisma: unknown, userId: string) => stored.get(userId) ?? [],
  saveDozoQuietHours: async (_deps: unknown, userId: string, ranges: Range[]) => {
    if (ranges.length) stored.set(userId, ranges);
    else stored.delete(userId);
  },
  suggestDozoQuietHours: async (_prisma: unknown, userId: string) =>
    suggestions.get(userId) ?? null,
}));

const NIGHT = { startMinute: 22 * 60, endMinute: 7 * 60 };
const EVERY_NIGHT = { ...NIGHT, days: DOZO_QUIET_DAYS.ALL };
const WEEKDAY_LUNCH = { startMinute: 12 * 60, endMinute: 13 * 60, days: DOZO_QUIET_DAYS.WEEKDAYS };
const WEEKEND_MORNING = { startMinute: 7 * 60, endMinute: 10 * 60, days: DOZO_QUIET_DAYS.WEEKEND };

function client(userId: string | null) {
  const ctx = createRouterContext({
    prisma: { space: { findUnique: async () => null } },
    events: { notify: () => undefined, publishSpaceChange: () => undefined },
    env: {},
  } as unknown as RouterDeps);
  return createRouterClient(dozoQuietHoursRoutes(ctx), {
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
  }).dozoQuietHours;
}

describe("quiet hours routes", () => {
  beforeEach(() => {
    stored.clear();
    suggestions.clear();
  });

  it("save and read the caller's own hours only", async () => {
    const off = { hours: null, ranges: [] };
    const night = { hours: NIGHT, ranges: [EVERY_NIGHT] };
    expect(await client("ada").get()).toEqual(off);
    expect(await client("ada").set({ hours: NIGHT })).toEqual(night);
    expect(await client("ada").get()).toEqual(night);
    expect(await client("eve").get()).toEqual(off);
    expect(await client("ada").set({ hours: null })).toEqual(off);
    expect(await client("ada").get()).toEqual(off);
  });

  it("save several ranges on their own days, and show the first to older clients", async () => {
    const both = {
      hours: { startMinute: 12 * 60, endMinute: 13 * 60 },
      ranges: [WEEKDAY_LUNCH, WEEKEND_MORNING],
    };
    expect(await client("ada").set({ ranges: [WEEKDAY_LUNCH, WEEKEND_MORNING] })).toEqual(both);
    expect(await client("ada").get()).toEqual(both);
    expect(stored.get("ada")).toEqual([WEEKDAY_LUNCH, WEEKEND_MORNING]);
  });

  it("take ranges over hours when given both, and an empty list as off", async () => {
    expect(await client("ada").set({ hours: NIGHT, ranges: [WEEKDAY_LUNCH] })).toMatchObject({
      ranges: [WEEKDAY_LUNCH],
    });
    expect(await client("ada").set({ hours: NIGHT, ranges: [] })).toEqual({
      hours: null,
      ranges: [],
    });
    expect(await client("ada").set({})).toEqual({ hours: null, ranges: [] });
    expect(stored.size).toBe(0);
  });

  it("refuse a range that starts where it ends, or a minute past the day", async () => {
    await expect(
      client("ada").set({ hours: { startMinute: 60, endMinute: 60 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client("ada").set({ hours: { startMinute: 0, endMinute: 1440 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client("ada").set({ ranges: [{ startMinute: 60, endMinute: 60, days: 1 }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(stored.size).toBe(0);
  });

  it("refuse more than four ranges, or days outside the week", async () => {
    await expect(
      client("ada").set({ ranges: Array.from({ length: 5 }, () => WEEKDAY_LUNCH) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    for (const days of [0, 128, 1.5])
      await expect(
        client("ada").set({ ranges: [{ ...WEEKDAY_LUNCH, days }] }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(stored.size).toBe(0);
  });

  it("suggest from the caller's own messages only, and save nothing", async () => {
    suggestions.set("eve", [EVERY_NIGHT]);
    expect(await client("ada").suggest()).toEqual({ ranges: null });
    expect(await client("eve").suggest()).toEqual({ ranges: [EVERY_NIGHT] });
    expect(stored.size).toBe(0);
  });

  it("refuse a caller who is not signed in", async () => {
    await expect(client(null).get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client(null).set({ hours: NIGHT })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client(null).suggest()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(stored.size).toBe(0);
  });
});
