import { createRouterClient } from "@orpc/server";
import { DOZO_QUIET_DAYS } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DOZO_QUIET_SUGGEST_PER_MINUTE, dozoQuietHoursRoutes } from "./dozo-quiet-hours.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

type Range = { startMinute: number; endMinute: number; days: number };
const stored = vi.hoisted(() => new Map<string, Range[]>());
/** Who wrote at night, by account: the suggestion reads only the caller's own messages. */
const suggestions = vi.hoisted(() => new Map<string, Range[]>());

vi.mock("@rakazo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/adapters")>();
  return {
    ...actual,
    readDozoQuietHours: async (_prisma: unknown, userId: string) => stored.get(userId) ?? [],
    // The same change as the database's: the pure part is the adapter's own.
    saveDozoQuietHours: async (
      _deps: unknown,
      userId: string,
      change: Parameters<typeof actual.dozoQuietRangesAfter>[1],
    ) => {
      const ranges = actual.dozoQuietRangesAfter(stored.get(userId) ?? [], change);
      if (ranges.length) stored.set(userId, ranges);
      else stored.delete(userId);
      return ranges;
    },
    suggestDozoQuietHours: async (_prisma: unknown, userId: string) =>
      suggestions.get(userId) ?? null,
  };
});

const NIGHT = { startMinute: 22 * 60, endMinute: 7 * 60 };
const EVERY_NIGHT = { ...NIGHT, days: DOZO_QUIET_DAYS.ALL };
const WEEKDAY_LUNCH = { startMinute: 12 * 60, endMinute: 13 * 60, days: DOZO_QUIET_DAYS.WEEKDAYS };
const WEEKEND_MORNING = { startMinute: 7 * 60, endMinute: 10 * 60, days: DOZO_QUIET_DAYS.WEEKEND };

let clock = 0;
let routes: ReturnType<typeof dozoQuietHoursRoutes>;

function client(userId: string | null) {
  return createRouterClient(routes, {
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

function routesAt() {
  const ctx = createRouterContext({
    prisma: { space: { findUnique: async () => null } },
    events: { notify: () => undefined, publishSpaceChange: () => undefined },
    env: {},
  } as unknown as RouterDeps);
  return dozoQuietHoursRoutes(ctx, () => clock);
}

describe("quiet hours routes", () => {
  beforeEach(() => {
    stored.clear();
    suggestions.clear();
    clock = 0;
    routes = routesAt();
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
    expect(await client("ada").set({ ranges: null })).toEqual({ hours: null, ranges: [] });
    expect(stored.size).toBe(0);
  });

  it("set new times on the first range only, keeping its days and the other ranges", async () => {
    await client("ada").set({ ranges: [WEEKDAY_LUNCH, WEEKEND_MORNING] });
    const early = { startMinute: 11 * 60, endMinute: 12 * 60 + 30 };
    expect(await client("ada").set({ hours: early })).toEqual({
      hours: early,
      ranges: [{ ...early, days: DOZO_QUIET_DAYS.WEEKDAYS }, WEEKEND_MORNING],
    });
    expect(await client("ada").get()).toMatchObject({ ranges: [{ ...early }, WEEKEND_MORNING] });
    // With none yet, `hours` is one range on every day; null turns every range off.
    expect(await client("eve").set({ hours: NIGHT })).toMatchObject({ ranges: [EVERY_NIGHT] });
    expect(await client("ada").set({ hours: null })).toEqual({ hours: null, ranges: [] });
    expect(stored.has("ada")).toBe(false);
  });

  it("refuse a save that names neither hours nor ranges", async () => {
    await client("ada").set({ ranges: [WEEKDAY_LUNCH] });
    await expect(client("ada").set({})).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(stored.get("ada")).toEqual([WEEKDAY_LUNCH]);
  });

  it("refuse ranges that leave no minute of the week outside them", async () => {
    const halves = [
      { startMinute: 0, endMinute: 12 * 60, days: DOZO_QUIET_DAYS.ALL },
      { startMinute: 12 * 60, endMinute: 0, days: DOZO_QUIET_DAYS.ALL },
    ];
    await expect(client("ada").set({ ranges: halves })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    // Nor by moving the first range onto the gap the others leave.
    const kept = [
      { startMinute: 60, endMinute: 120, days: DOZO_QUIET_DAYS.ALL },
      halves[1] as Range,
    ];
    await client("ada").set({ ranges: kept });
    await expect(
      client("ada").set({ hours: { startMinute: 0, endMinute: 12 * 60 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(stored.get("ada")).toEqual(kept);
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

  it("refuse a burst of suggestions from one account until a minute has passed", async () => {
    for (let ask = 0; ask < DOZO_QUIET_SUGGEST_PER_MINUTE; ask += 1) await client("ada").suggest();
    await expect(client("ada").suggest()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // Another account is not held by it.
    expect(await client("eve").suggest()).toEqual({ ranges: null });
    clock += 60_000;
    expect(await client("ada").suggest()).toEqual({ ranges: null });
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
