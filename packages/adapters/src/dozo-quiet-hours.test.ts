import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { DozoQuietRange } from "@rakazo/contracts";
import { DOZO_QUIET_DAYS, dozoQuietDayBit } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOZO_ROUTINE_CATCH_UP_MS,
  dozoHoldRoutine,
  dozoInQuietHours,
  dozoQuietHoursCoverWeek,
  dozoQuietHoursEnd,
  readDozoQuietHours,
  saveDozoQuietHours,
} from "./dozo-quiet-hours.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { wakeRoutine } from "./run-routines.js";

const HOUR = 60 * 60_000;
const { ALL } = DOZO_QUIET_DAYS;
const NIGHT = { startMinute: 22 * 60, endMinute: 7 * 60, days: ALL };
const MONDAY = 0;
const WEDNESDAY = 2;
const FRIDAY = 4;
const SATURDAY = 5;
const SUNDAY = 6;

describe("quiet hours", () => {
  it("cover a range across midnight, start included and end not", () => {
    const at = (iso: string) => dozoInQuietHours([NIGHT], new Date(iso), "UTC");
    expect(at("2026-11-20T21:59:00Z")).toBe(false);
    expect(at("2026-11-20T22:00:00Z")).toBe(true);
    expect(at("2026-11-21T03:00:00Z")).toBe(true);
    expect(at("2026-11-21T07:00:00Z")).toBe(false);
  });

  it("cover a range inside one day", () => {
    const lunch = [{ startMinute: 12 * 60, endMinute: 13 * 60 + 30, days: ALL }];
    expect(dozoInQuietHours(lunch, new Date("2026-11-20T11:59:00Z"), "UTC")).toBe(false);
    expect(dozoInQuietHours(lunch, new Date("2026-11-20T13:29:00Z"), "UTC")).toBe(true);
    expect(dozoInQuietHours(lunch, new Date("2026-11-20T13:30:00Z"), "UTC")).toBe(false);
  });

  it("are read in the given zone, and in UTC for a zone that does not exist", () => {
    // 23:30 in Istanbul (UTC+3) is 20:30 UTC.
    const at = new Date("2026-11-20T20:30:00Z");
    expect(dozoInQuietHours([NIGHT], at, "Europe/Istanbul")).toBe(true);
    expect(dozoInQuietHours([NIGHT], at, "Not/AZone")).toBe(false);
  });

  it("end at the first minute outside them", () => {
    expect(dozoQuietHoursEnd([NIGHT], new Date("2026-11-20T23:15:30Z"), "UTC")).toEqual(
      new Date("2026-11-21T07:00:00Z"),
    );
    expect(dozoQuietHoursEnd([NIGHT], new Date("2026-11-20T23:00:00Z"), "Europe/Istanbul")).toEqual(
      new Date("2026-11-21T04:00:00Z"),
    );
  });

  it("end after the gap when a clock change skips their end", () => {
    // Berlin skips 02:00-03:00 on Sunday 29 March 2026; an end at 02:30 becomes 03:00 local (01:00 UTC).
    const early = [{ startMinute: 0, endMinute: 2 * 60 + 30, days: ALL }];
    expect(dozoQuietHoursEnd(early, new Date("2026-03-28T23:30:00Z"), "Europe/Berlin")).toEqual(
      new Date("2026-03-29T01:00:00Z"),
    );
  });

  it("give up after a day when ranges never end", () => {
    const always = [
      { startMinute: 0, endMinute: 12 * 60, days: ALL },
      { startMinute: 12 * 60, endMinute: 0, days: ALL },
    ];
    expect(dozoQuietHoursEnd(always, new Date("2026-11-20T10:00:00Z"), "UTC")).toEqual(
      new Date("2026-11-21T10:01:00Z"),
    );
  });

  it("are the union of their ranges, overlapping ones included", () => {
    const ranges = [
      { startMinute: 22 * 60, endMinute: 2 * 60, days: ALL },
      { startMinute: 60, endMinute: 7 * 60, days: ALL },
    ];
    const at = (iso: string) => dozoInQuietHours(ranges, new Date(iso), "UTC");
    expect(at("2026-11-20T21:59:00Z")).toBe(false);
    expect(at("2026-11-20T23:00:00Z")).toBe(true);
    expect(at("2026-11-21T01:30:00Z")).toBe(true);
    expect(at("2026-11-21T06:59:00Z")).toBe(true);
    expect(at("2026-11-21T07:00:00Z")).toBe(false);
    expect(dozoQuietHoursEnd(ranges, new Date("2026-11-20T23:00:00Z"), "UTC")).toEqual(
      new Date("2026-11-21T07:00:00Z"),
    );
  });

  it("end where the last of touching ranges ends", () => {
    const ranges = [
      { startMinute: 22 * 60, endMinute: 0, days: ALL },
      { startMinute: 0, endMinute: 6 * 60, days: ALL },
      { startMinute: 6 * 60, endMinute: 6 * 60 + 30, days: ALL },
    ];
    expect(dozoQuietHoursEnd(ranges, new Date("2026-11-20T22:30:00Z"), "UTC")).toEqual(
      new Date("2026-11-21T06:30:00Z"),
    );
  });

  it("follow a range across days, past the old one-day limit", () => {
    // The whole weekend: Saturday and Sunday, each in two halves. 21 November 2026 is a Saturday.
    const weekend = dozoQuietDayBit(SATURDAY) | dozoQuietDayBit(SUNDAY);
    expect(weekend).toBe(DOZO_QUIET_DAYS.WEEKEND);
    const ranges = [
      { startMinute: 0, endMinute: 12 * 60, days: weekend },
      { startMinute: 12 * 60, endMinute: 0, days: weekend },
    ];
    expect(dozoQuietHoursEnd(ranges, new Date("2026-11-21T10:00:00Z"), "UTC")).toEqual(
      new Date("2026-11-23T00:00:00Z"),
    );
  });

  it("hold a range to the day it starts on, its morning included", () => {
    // Friday 22:00 to 07:00: Saturday morning is quiet, Sunday morning and Thursday night are not.
    const friday = [{ startMinute: 22 * 60, endMinute: 7 * 60, days: dozoQuietDayBit(FRIDAY) }];
    const at = (iso: string) => dozoInQuietHours(friday, new Date(iso), "UTC");
    expect(at("2026-11-19T23:00:00Z")).toBe(false);
    expect(at("2026-11-20T23:00:00Z")).toBe(true);
    expect(at("2026-11-21T06:00:00Z")).toBe(true);
    expect(at("2026-11-21T23:00:00Z")).toBe(false);
    expect(at("2026-11-22T06:00:00Z")).toBe(false);
    expect(dozoQuietHoursEnd(friday, new Date("2026-11-20T23:00:00Z"), "UTC")).toEqual(
      new Date("2026-11-21T07:00:00Z"),
    );
  });

  it("cover only the days picked", () => {
    const days = dozoQuietDayBit(MONDAY) | dozoQuietDayBit(WEDNESDAY);
    const lunch = [{ startMinute: 12 * 60, endMinute: 13 * 60, days }];
    const at = (iso: string) => dozoInQuietHours(lunch, new Date(iso), "UTC");
    expect(at("2026-11-16T12:30:00Z")).toBe(true);
    expect(at("2026-11-17T12:30:00Z")).toBe(false);
    expect(at("2026-11-18T12:30:00Z")).toBe(true);
    expect(at("2026-11-22T12:30:00Z")).toBe(false);
  });

  it("take the day in the given zone", () => {
    // 22:30 UTC on Friday is 01:30 on Saturday in Istanbul.
    const saturday = [{ startMinute: 0, endMinute: 3 * 60, days: dozoQuietDayBit(SATURDAY) }];
    const at = new Date("2026-11-20T22:30:00Z");
    expect(dozoInQuietHours(saturday, at, "Europe/Istanbul")).toBe(true);
    expect(dozoInQuietHours(saturday, at, "UTC")).toBe(false);
  });

  it("keep their day across a clock change", () => {
    // 29 March 2026, when Berlin skips 02:00-03:00, is a Sunday; 00:30 local is 23:30 UTC on Saturday.
    const early = { startMinute: 0, endMinute: 2 * 60 + 30 };
    const sunday = [{ ...early, days: dozoQuietDayBit(SUNDAY) }];
    const saturday = [{ ...early, days: dozoQuietDayBit(SATURDAY) }];
    const at = new Date("2026-03-28T23:30:00Z");
    expect(dozoInQuietHours(sunday, at, "Europe/Berlin")).toBe(true);
    expect(dozoInQuietHours(saturday, at, "Europe/Berlin")).toBe(false);
    expect(dozoQuietHoursEnd(sunday, at, "Europe/Berlin")).toEqual(
      new Date("2026-03-29T01:00:00Z"),
    );
    // Berlin repeats 02:00-03:00 on Sunday 25 October 2026: an end at 02:30 is its first one.
    expect(dozoQuietHoursEnd(sunday, new Date("2026-10-24T23:00:00Z"), "Europe/Berlin")).toEqual(
      new Date("2026-10-25T00:30:00Z"),
    );
  });

  it("ask the zone for its clock once a quarter hour, not once a minute", () => {
    const always = [
      { startMinute: 0, endMinute: 12 * 60, days: ALL },
      { startMinute: 12 * 60, endMinute: 0, days: ALL },
    ];
    const asked = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      dozoQuietHoursEnd(always, new Date("2026-11-20T10:00:00Z"), "Europe/Istanbul");
      // The walk covers eight days and two hours: 776 quarter hours.
      expect(asked.mock.calls.length).toBeLessThanOrEqual(8 * 24 * 4 + 8 + 1);
    } finally {
      asked.mockRestore();
    }
  });

  it("read several ranges in UTC for a zone that does not exist", () => {
    const ranges = [
      { startMinute: 12 * 60, endMinute: 13 * 60, days: DOZO_QUIET_DAYS.WEEKDAYS },
      { ...NIGHT, days: DOZO_QUIET_DAYS.WEEKEND },
    ];
    // Friday 20 November 2026, 12:30 UTC: lunch on a weekday, not in Istanbul (15:30).
    const lunch = new Date("2026-11-20T12:30:00Z");
    expect(dozoInQuietHours(ranges, lunch, "Not/AZone")).toBe(true);
    expect(dozoInQuietHours(ranges, lunch, "Europe/Istanbul")).toBe(false);
    expect(dozoQuietHoursEnd(ranges, lunch, "Not/AZone")).toEqual(new Date("2026-11-20T13:00:00Z"));
    // Saturday 23:00 UTC is in the weekend night until Sunday 07:00 UTC.
    const night = new Date("2026-11-21T23:00:00Z");
    expect(dozoInQuietHours(ranges, night, "Not/AZone")).toBe(true);
    expect(dozoQuietHoursEnd(ranges, night, "Not/AZone")).toEqual(new Date("2026-11-22T07:00:00Z"));
  });

  it("read the hour a clock change repeats twice, across several ranges", () => {
    // Berlin goes from 03:00 summer time back to 02:00 on Sunday 25 October 2026: 02:00-02:59
    // comes at 00:00 UTC and again at 01:00 UTC. Two touching Sunday ranges end at 02:45.
    const sunday = dozoQuietDayBit(SUNDAY);
    const ranges = [
      { startMinute: 60, endMinute: 2 * 60 + 30, days: sunday },
      { startMinute: 2 * 60 + 30, endMinute: 2 * 60 + 45, days: sunday },
    ];
    const at = (iso: string) => dozoInQuietHours(ranges, new Date(iso), "Europe/Berlin");
    expect(at("2026-10-25T00:40:00Z")).toBe(true); // 02:40, first time
    expect(at("2026-10-25T00:50:00Z")).toBe(false); // 02:50, first time
    expect(at("2026-10-25T01:10:00Z")).toBe(true); // 02:10, second time
    expect(at("2026-10-25T01:50:00Z")).toBe(false); // 02:50, second time
    // The first 02:45 ends them; inside the repeat, the second one does.
    expect(dozoQuietHoursEnd(ranges, new Date("2026-10-24T23:30:00Z"), "Europe/Berlin")).toEqual(
      new Date("2026-10-25T00:45:00Z"),
    );
    expect(dozoQuietHoursEnd(ranges, new Date("2026-10-25T01:10:00Z"), "Europe/Berlin")).toEqual(
      new Date("2026-10-25T01:45:00Z"),
    );
  });
});

describe("ranges that cover the whole week", () => {
  const range = (startHour: number, endHour: number, days: number = ALL) => ({
    startMinute: startHour * 60,
    endMinute: endHour * 60,
    days,
  });

  it("are two halves of every day, or a day and a night", () => {
    expect(dozoQuietHoursCoverWeek([range(0, 12), range(12, 0)])).toBe(true);
    expect(dozoQuietHoursCoverWeek([range(22, 7), range(7, 22)])).toBe(true);
    expect(dozoQuietHoursCoverWeek([range(22, 7), range(7, 21)])).toBe(false);
    expect(dozoQuietHoursCoverWeek([NIGHT])).toBe(false);
    expect(dozoQuietHoursCoverWeek([])).toBe(false);
  });

  it("are counted per day, with the morning of a range across midnight", () => {
    const { WEEKDAYS, WEEKEND } = DOZO_QUIET_DAYS;
    expect(
      dozoQuietHoursCoverWeek([
        range(0, 12, WEEKDAYS),
        range(12, 0, WEEKDAYS),
        range(0, 12, WEEKEND),
        range(12, 0, WEEKEND),
      ]),
    ).toBe(true);
    // 01:00 to 00:00 the next day covers all but the hour after midnight; that hour on every day
    // but Monday leaves Monday's.
    const allButMonday = ALL & ~dozoQuietDayBit(MONDAY);
    expect(dozoQuietHoursCoverWeek([range(1, 0), range(0, 1)])).toBe(true);
    expect(dozoQuietHoursCoverWeek([range(1, 0), range(0, 1, allButMonday)])).toBe(false);
    // Across midnight, the morning belongs to the day before: only Monday's own 07:00 is left.
    expect(dozoQuietHoursCoverWeek([range(8, 7), range(7, 8, allButMonday)])).toBe(false);
    expect(dozoQuietHoursCoverWeek([range(23, 1), range(1, 23)])).toBe(true);
  });
});

type Routine = {
  id: string;
  spaceId: string;
  userId: string;
  crons: string[];
  timezone: string;
  watch: unknown;
  active: boolean;
  nextRunAt: Date | null;
};
type Hold = { dueAt: Date; heldUntil: Date; crons: string[]; timezone: string };

const sameSchedule = (
  a: { crons: string[]; timezone: string },
  b: { crons: string[]; timezone: string },
) => a.timezone === b.timezone && a.crons.join("\n") === b.crons.join("\n");

/** The rows the module reads and writes, behind the few calls it makes. */
function fakeDatabase() {
  const routines = new Map<string, Routine>();
  const holds = new Map<string, Hold>();
  const ranges = new Map<string, DozoQuietRange[]>();
  /** The previous release's single range, kept in step with the first of the new ones. */
  const quiet = new Map<string, { startMinute: number; endMinute: number }>();
  const users = new Map<string, { timezone: string | null }>();
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  /** Both tables as the queries select them: array_agg gives null for no rows. */
  const quietColumns = (userId: string) => {
    const list = ranges.get(userId) ?? [];
    const hours = quiet.get(userId);
    const column = (pick: (range: DozoQuietRange) => number) =>
      list.length ? list.map(pick) : null;
    return {
      startMinute: hours?.startMinute ?? null,
      endMinute: hours?.endMinute ?? null,
      rangeStarts: column((range) => range.startMinute),
      rangeEnds: column((range) => range.endMinute),
      rangeDays: column((range) => range.days),
    };
  };
  const client = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql(strings);
      if (text.includes("pg_advisory_xact_lock")) return [{ lock: "" }];
      if (text.includes('FROM "user" u') && text.includes("dozo_routine_holds h ON")) {
        const [routineId, crons, timezone, userId] = values as [string, string[], string, string];
        const user = users.get(userId);
        if (!user) return [];
        const stored = holds.get(routineId);
        const hold = stored && sameSchedule(stored, { crons, timezone }) ? stored : undefined;
        return [
          {
            dueAt: hold?.dueAt ?? null,
            heldUntil: hold?.heldUntil ?? null,
            ...quietColumns(userId),
            timezone: user.timezone,
          },
        ];
      }
      if (text.includes("AS id) u")) return [quietColumns(values[0] as string)];
      if (text.includes("FROM dozo_routine_holds h JOIN")) {
        return [...holds.entries()].flatMap(([routineId, hold]) => {
          const routine = routines.get(routineId);
          if (!routine) return [];
          return routine.userId === values[0] &&
            routine.active &&
            hold.heldUntil > new Date() &&
            sameSchedule(hold, routine)
            ? [
                {
                  routineId,
                  spaceId: routine.spaceId,
                  dueAt: hold.dueAt,
                  heldUntil: hold.heldUntil,
                },
              ]
            : [];
        });
      }
      throw new Error(`unexpected query: ${text}`);
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql(strings);
      if (text.includes("DELETE FROM dozo_quiet_hour_ranges")) {
        ranges.delete(values[0] as string);
      } else if (text.includes("INSERT INTO dozo_quiet_hour_ranges")) {
        const [userId, starts, ends, days] = values as [string, number[], number[], number[]];
        ranges.set(
          userId,
          starts.map((startMinute, index) => ({
            startMinute,
            endMinute: ends[index] as number,
            days: days[index] as number,
          })),
        );
      } else if (text.includes("INSERT INTO dozo_quiet_hours")) {
        const [userId, startMinute, endMinute] = values as [string, number, number];
        quiet.set(userId, { startMinute, endMinute });
      } else if (text.includes("DELETE FROM dozo_quiet_hours")) {
        quiet.delete(values[0] as string);
      } else if (text.includes("INSERT INTO dozo_routine_holds")) {
        const [routineId, dueAt, heldUntil, crons, timezone] = values as [
          string,
          string,
          string,
          string[],
          string,
        ];
        holds.set(routineId, {
          dueAt: new Date(dueAt),
          heldUntil: new Date(heldUntil),
          crons,
          timezone,
        });
      } else throw new Error(`unexpected statement: ${text}`);
      return 1;
    }),
    routine: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const routine = routines.get(where.id);
        return routine && { ...routine, space: { deletingAt: null } };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; active: boolean; nextRunAt: Date };
          data: Partial<Routine>;
        }) => {
          const routine = routines.get(where.id);
          if (
            !routine ||
            routine.active !== where.active ||
            routine.nextRunAt?.getTime() !== where.nextRunAt.getTime()
          )
            return { count: 0 };
          Object.assign(routine, data);
          return { count: 1 };
        },
      ),
    },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(client),
  };
  /** Both tables as a save by this release leaves them. */
  const setRanges = (userId: string, list: DozoQuietRange[]) => {
    ranges.set(userId, list);
    const [first] = list;
    if (first) quiet.set(userId, { startMinute: first.startMinute, endMinute: first.endMinute });
  };
  /** A save by the previous release, which knows only its own table: one range, or none. */
  const previousRelease = (
    userId: string,
    hours: { startMinute: number; endMinute: number } | null,
  ) => {
    if (hours) quiet.set(userId, hours);
    else quiet.delete(userId);
  };
  const enqueued: BackgroundJob[] = [];
  const jobs: JobPublisher = {
    enqueue: vi.fn(async (job: BackgroundJob) => {
      enqueued.push(job);
    }),
    enqueueIn: async () => undefined,
    cancelIn: async () => undefined,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  const publishSpaceChange = vi.fn(async () => undefined);
  const deps = {
    prisma: client as unknown as PrismaClient,
    jobs,
    events: { publishSpaceChange },
  };
  const addRoutine = (routine: Partial<Routine> & { nextRunAt: Date }) => {
    const row: Routine = {
      id: "routine-1",
      spaceId: "space-1",
      userId: "user-1",
      crons: ["0 * * * *"],
      timezone: "UTC",
      watch: null,
      active: true,
      ...routine,
    };
    routines.set(row.id, row);
    if (!users.has(row.userId)) users.set(row.userId, { timezone: null });
    return row;
  };
  /** Holds a routine under the schedule it has now. */
  const hold = (routineId: string, dueAt: Date, heldUntil: Date) => {
    const routine = routines.get(routineId);
    if (!routine) throw new Error(`no routine ${routineId}`);
    holds.set(routineId, { dueAt, heldUntil, crons: routine.crons, timezone: routine.timezone });
  };
  return {
    routines,
    holds,
    ranges,
    quiet,
    users,
    deps,
    enqueued,
    publishSpaceChange,
    addRoutine,
    hold,
    setRanges,
    previousRelease,
  };
}

const NOW = new Date("2026-11-20T23:00:00Z");

describe("a due routine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs as before outside quiet hours", async () => {
    const db = fakeDatabase();
    const routine = db.addRoutine({ nextRunAt: NOW });
    const wake = vi.fn(async () => undefined);
    expect(await dozoHoldRoutine(db.deps, routine, NOW, wake)).toBe(false);
    expect(routine.nextRunAt).toEqual(NOW);
    expect(db.enqueued).toEqual([]);
  });

  it("runs as before for an owner the database does not have", async () => {
    const db = fakeDatabase();
    const routine = db.addRoutine({ nextRunAt: NOW });
    db.users.clear();
    expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(false);
  });

  it("runs as before when its quiet hours cannot be read", async () => {
    const db = fakeDatabase();
    db.setRanges("user-1", [NIGHT]);
    const routine = db.addRoutine({ nextRunAt: NOW });
    const prisma = db.deps.prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> };
    prisma.$queryRaw.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(false);
    expect(routine.nextRunAt).toEqual(NOW);
  });

  it("waits until quiet hours end, remembering when it was due", async () => {
    const db = fakeDatabase();
    db.setRanges("user-1", [NIGHT]);
    const routine = db.addRoutine({ nextRunAt: NOW });
    const end = new Date("2026-11-21T07:00:00Z");
    expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(true);
    expect(routine.nextRunAt).toEqual(end);
    expect(db.holds.get("routine-1")).toEqual({
      dueAt: NOW,
      heldUntil: end,
      crons: ["0 * * * *"],
      timezone: "UTC",
    });
    expect(db.enqueued).toEqual([
      expect.objectContaining({
        name: "routine.wakeup",
        payload: { routineId: "routine-1", scheduledFor: end.toISOString() },
        availableAt: end,
      }),
    ]);
    expect(db.publishSpaceChange).toHaveBeenCalledWith("space-1", "routines");
  });

  it("waits through touching ranges until the last one ends", async () => {
    const db = fakeDatabase();
    db.setRanges("user-1", [
      { startMinute: 22 * 60, endMinute: 0, days: ALL },
      { startMinute: 0, endMinute: 9 * 60, days: dozoQuietDayBit(SATURDAY) },
    ]);
    const routine = db.addRoutine({ nextRunAt: NOW });
    expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(true);
    expect(routine.nextRunAt).toEqual(new Date("2026-11-21T09:00:00Z"));
  });

  it("runs on a day its owner's ranges leave out", async () => {
    const db = fakeDatabase();
    // NOW is Friday 23:00 UTC; the range is on weekends only.
    db.setRanges("user-1", [{ ...NIGHT, days: DOZO_QUIET_DAYS.WEEKEND }]);
    const routine = db.addRoutine({ nextRunAt: NOW });
    expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(false);
    expect(routine.nextRunAt).toEqual(NOW);
  });

  it("reads quiet hours in the owner's zone before the routine's", async () => {
    const db = fakeDatabase();
    db.setRanges("user-1", [NIGHT]);
    // 23:00 UTC is 15:00 in Los Angeles: not quiet there, though it is in UTC.
    db.users.set("user-1", { timezone: "America/Los_Angeles" });
    const routine = db.addRoutine({ nextRunAt: NOW });
    expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(false);
  });

  it("does nothing when the schedule moved before it could wait", async () => {
    const db = fakeDatabase();
    db.setRanges("user-1", [NIGHT]);
    const routine = db.addRoutine({ nextRunAt: new Date(NOW.getTime() + HOUR) });
    expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(true);
    expect(db.holds.size).toBe(0);
    expect(db.enqueued).toEqual([]);
  });

  it("goes back to its due time when the wait ends, and wakes that", async () => {
    const db = fakeDatabase();
    const due = new Date("2026-11-21T03:00:00Z");
    const end = new Date("2026-11-21T07:00:00Z");
    vi.setSystemTime(end);
    const routine = db.addRoutine({ nextRunAt: end, crons: ["0 3 * * *"] });
    db.hold("routine-1", due, end);
    const wake = vi.fn(async () => undefined);
    expect(await dozoHoldRoutine(db.deps, routine, end, wake)).toBe(true);
    expect(routine.nextRunAt).toEqual(due);
    expect(wake).toHaveBeenCalledWith(db.deps, "routine-1", due.toISOString());
  });

  it("does not wake an edited routine when its old wait ends", async () => {
    const db = fakeDatabase();
    const end = new Date("2026-11-21T07:00:00Z");
    vi.setSystemTime(end);
    const routine = db.addRoutine({ nextRunAt: new Date("2026-11-21T09:00:00Z") });
    db.hold("routine-1", NOW, end);
    const wake = vi.fn(async () => undefined);
    expect(await dozoHoldRoutine(db.deps, routine, end, wake)).toBe(true);
    expect(wake).not.toHaveBeenCalled();
  });

  it("forgets a wait once its schedule is edited, even onto the same time", async () => {
    const db = fakeDatabase();
    const end = new Date("2026-11-21T07:00:00Z");
    vi.setSystemTime(new Date("2026-11-21T06:30:00Z"));
    const routine = db.addRoutine({ nextRunAt: end, crons: ["0 6 * * *"] });
    db.hold("routine-1", new Date("2026-11-21T06:00:00Z"), end);
    routine.crons = ["0 7 * * *"];
    vi.setSystemTime(end);
    const wake = vi.fn(async () => undefined);
    expect(await dozoHoldRoutine(db.deps, routine, end, wake)).toBe(false);
    expect(wake).not.toHaveBeenCalled();
    expect(routine.nextRunAt).toEqual(end);
  });

  it("runs once a long-missed repeat whose schedule no longer parses, as before", async () => {
    const db = fakeDatabase();
    const due = new Date(NOW.getTime() - 3 * 24 * HOUR);
    const routine = db.addRoutine({ nextRunAt: due, crons: ["not a cron"] });
    expect(await dozoHoldRoutine(db.deps, routine, due, vi.fn())).toBe(false);
    expect(routine).toMatchObject({ active: true, nextRunAt: due });
  });

  it("runs once when it was missed by less than the catch-up window", async () => {
    const db = fakeDatabase();
    const due = new Date(NOW.getTime() - 11 * HOUR);
    const routine = db.addRoutine({ nextRunAt: due, crons: ["0 12 * * 1"] });
    expect(await dozoHoldRoutine(db.deps, routine, due, vi.fn())).toBe(false);
  });

  it("runs when an older miss has a newer occurrence inside the window", async () => {
    const db = fakeDatabase();
    const due = new Date(NOW.getTime() - 3 * 24 * HOUR);
    const routine = db.addRoutine({ nextRunAt: due });
    expect(await dozoHoldRoutine(db.deps, routine, due, vi.fn())).toBe(false);
  });

  it("skips to its next occurrence when every miss is older than the window", async () => {
    const db = fakeDatabase();
    // Mondays at noon; the last one was 20 November 2026 minus four days.
    const due = new Date("2026-11-16T12:00:00Z");
    const routine = db.addRoutine({ nextRunAt: due, crons: ["0 12 * * 1"] });
    expect(NOW.getTime() - due.getTime()).toBeGreaterThan(DOZO_ROUTINE_CATCH_UP_MS);
    expect(await dozoHoldRoutine(db.deps, routine, due, vi.fn())).toBe(true);
    const next = new Date("2026-11-23T12:00:00Z");
    expect(routine).toMatchObject({ active: true, nextRunAt: next });
    expect(db.enqueued).toEqual([expect.objectContaining({ availableAt: next })]);
    expect(db.publishSpaceChange).toHaveBeenCalledWith("space-1", "routines");
  });

  it("ends a one-time routine missed by more than the window", async () => {
    const db = fakeDatabase();
    const due = new Date(NOW.getTime() - 13 * HOUR);
    const routine = db.addRoutine({ nextRunAt: due, crons: ["@once"] });
    expect(await dozoHoldRoutine(db.deps, routine, due, vi.fn())).toBe(true);
    expect(routine).toMatchObject({ active: false, nextRunAt: null });
    expect(db.enqueued).toEqual([]);
  });

  it("leaves a skip to whoever moved the schedule first", async () => {
    const db = fakeDatabase();
    const due = new Date(NOW.getTime() - 13 * HOUR);
    const routine = db.addRoutine({ nextRunAt: NOW, crons: ["@once"] });
    expect(await dozoHoldRoutine(db.deps, routine, due, vi.fn())).toBe(true);
    expect(routine).toMatchObject({ active: true, nextRunAt: NOW });
    expect(db.publishSpaceChange).not.toHaveBeenCalled();
  });

  it("counts a held run as due when its wait ended", async () => {
    const db = fakeDatabase();
    const due = new Date(NOW.getTime() - 20 * HOUR);
    const end = new Date(NOW.getTime() - 2 * HOUR);
    const routine = db.addRoutine({ nextRunAt: due, crons: ["@once"] });
    db.hold("routine-1", due, end);
    expect(await dozoHoldRoutine(db.deps, routine, due, vi.fn())).toBe(false);
  });

  it("waits from the routine wakeup itself", async () => {
    const db = fakeDatabase();
    db.setRanges("user-1", [NIGHT]);
    const routine = db.addRoutine({ nextRunAt: NOW });
    await wakeRoutine(db.deps as unknown as ExecutorDeps, "routine-1", NOW.toISOString());
    expect(routine.nextRunAt).toEqual(new Date("2026-11-21T07:00:00Z"));
    expect(db.holds.get("routine-1")?.dueAt).toEqual(NOW);
  });

  it("never skips a change check, however late", async () => {
    const db = fakeDatabase();
    const due = new Date(NOW.getTime() - 3 * 24 * HOUR);
    const routine = db.addRoutine({ nextRunAt: due, crons: [], watch: { everyMinutes: 60 } });
    expect(await dozoHoldRoutine(db.deps, routine, due, vi.fn())).toBe(false);
  });
});

describe("saving quiet hours", () => {
  const LUNCH = { startMinute: 12 * 60, endMinute: 13 * 60, days: DOZO_QUIET_DAYS.WEEKDAYS };

  it("reads nothing before they are set", async () => {
    const db = fakeDatabase();
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toEqual([]);
  });

  it("sets, changes and clears them", async () => {
    const db = fakeDatabase();
    await saveDozoQuietHours(db.deps, "user-1", [NIGHT]);
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toEqual([NIGHT]);
    await saveDozoQuietHours(db.deps, "user-1", [LUNCH, NIGHT]);
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toEqual([LUNCH, NIGHT]);
    await saveDozoQuietHours(db.deps, "user-1", []);
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toEqual([]);
    expect(db.enqueued).toEqual([]);
  });

  it("keep the previous release's single range in step with the first one", async () => {
    const db = fakeDatabase();
    await saveDozoQuietHours(db.deps, "user-1", [LUNCH, NIGHT]);
    expect(db.quiet.get("user-1")).toEqual({ startMinute: 12 * 60, endMinute: 13 * 60 });
    await saveDozoQuietHours(db.deps, "user-1", []);
    expect(db.quiet.has("user-1")).toBe(false);
  });

  it("read a single range saved by the previous release as one on every day", async () => {
    const db = fakeDatabase();
    db.previousRelease("user-1", { startMinute: 22 * 60, endMinute: 7 * 60 });
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toEqual([NIGHT]);
  });

  it("hold a routine on a single range saved by the previous release", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const db = fakeDatabase();
      db.previousRelease("user-1", { startMinute: 22 * 60, endMinute: 7 * 60 });
      const routine = db.addRoutine({ nextRunAt: NOW });
      expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(true);
      expect(routine.nextRunAt).toEqual(new Date("2026-11-21T07:00:00Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("set new times on the first range only, keeping its days and the other ranges", async () => {
    const db = fakeDatabase();
    const early = { startMinute: 11 * 60, endMinute: 12 * 60 };
    // With none yet, one range on every day.
    expect(await saveDozoQuietHours(db.deps, "user-1", { hours: early })).toEqual([
      { ...early, days: ALL },
    ]);
    await saveDozoQuietHours(db.deps, "user-1", [LUNCH, NIGHT]);
    expect(await saveDozoQuietHours(db.deps, "user-1", { hours: early })).toEqual([
      { ...early, days: DOZO_QUIET_DAYS.WEEKDAYS },
      NIGHT,
    ]);
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toEqual([
      { ...early, days: DOZO_QUIET_DAYS.WEEKDAYS },
      NIGHT,
    ]);
    expect(db.quiet.get("user-1")).toEqual(early);
  });

  it("refuse ranges that leave no minute outside them, and keep the saved ones", async () => {
    const db = fakeDatabase();
    await saveDozoQuietHours(db.deps, "user-1", [NIGHT]);
    const day = { startMinute: 7 * 60, endMinute: 22 * 60, days: ALL };
    await expect(saveDozoQuietHours(db.deps, "user-1", [NIGHT, day])).rejects.toMatchObject({
      name: "ClientError",
      kind: "BAD_REQUEST",
    });
    // Nor by moving the first range onto the gap the other leaves.
    const lunch = { ...LUNCH, days: ALL };
    await saveDozoQuietHours(db.deps, "user-1", [lunch, day]);
    await expect(
      saveDozoQuietHours(db.deps, "user-1", { hours: { startMinute: 22 * 60, endMinute: 7 * 60 } }),
    ).rejects.toBeInstanceOf(ClientError);
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toEqual([lunch, day]);
  });

  it("take the previous release's change made after this release saved", async () => {
    const db = fakeDatabase();
    // Untouched since: as saved.
    db.setRanges("user-1", [LUNCH, NIGHT]);
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toEqual([LUNCH, NIGHT]);
    // Changed by the previous release: its times on the first range, days and the rest kept.
    db.previousRelease("user-1", { startMinute: 8 * 60, endMinute: 9 * 60 });
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toEqual([
      { startMinute: 8 * 60, endMinute: 9 * 60, days: DOZO_QUIET_DAYS.WEEKDAYS },
      NIGHT,
    ]);
    // A save of new times starts from what it reads.
    expect(
      await saveDozoQuietHours(db.deps, "user-1", {
        hours: { startMinute: 9 * 60, endMinute: 10 * 60 },
      }),
    ).toEqual([{ startMinute: 9 * 60, endMinute: 10 * 60, days: DOZO_QUIET_DAYS.WEEKDAYS }, NIGHT]);
    // Turned off by the previous release: off, though the ranges are still there.
    db.previousRelease("user-1", null);
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toEqual([]);
    expect(db.ranges.get("user-1")).toHaveLength(2);
  });

  it("hold no routine on ranges the previous release turned off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const db = fakeDatabase();
      db.setRanges("user-1", [NIGHT]);
      db.previousRelease("user-1", null);
      const routine = db.addRoutine({ nextRunAt: NOW });
      expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(false);
      // Set again by the previous release, to an evening: held until it ends.
      db.previousRelease("user-1", { startMinute: 21 * 60, endMinute: 23 * 60 + 30 });
      expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(true);
      expect(routine.nextRunAt).toEqual(new Date("2026-11-20T23:30:00Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends routines waiting on the old hours back to when they were due", async () => {
    const db = fakeDatabase();
    const due = new Date(Date.now() - HOUR);
    const end = new Date(Date.now() + 5 * HOUR);
    const waiting = db.addRoutine({ id: "waiting", nextRunAt: end });
    db.hold("waiting", due, end);
    // Edited since it was held: it keeps its new schedule.
    const edited = db.addRoutine({ id: "edited", spaceId: "space-2", nextRunAt: due });
    db.hold("edited", due, end);
    // Moved onto the same time under a new schedule: not the routine that was held.
    const moved = db.addRoutine({ id: "moved", nextRunAt: end });
    db.hold("moved", due, end);
    moved.crons = ["30 * * * *"];
    // Another account's routine.
    db.addRoutine({ id: "theirs", userId: "user-2", nextRunAt: end });
    db.hold("theirs", due, end);

    await saveDozoQuietHours(db.deps, "user-1", []);

    expect(waiting.nextRunAt).toEqual(due);
    expect(edited.nextRunAt).toEqual(due);
    expect(moved.nextRunAt).toEqual(end);
    expect(db.routines.get("theirs")?.nextRunAt).toEqual(end);
    expect(db.enqueued).toEqual([
      expect.objectContaining({
        payload: { routineId: "waiting", scheduledFor: due.toISOString() },
      }),
    ]);
    expect(db.publishSpaceChange).toHaveBeenCalledExactlyOnceWith("space-1", "routines");
  });
});
