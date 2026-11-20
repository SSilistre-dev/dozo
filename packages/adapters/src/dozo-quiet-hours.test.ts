import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOZO_ROUTINE_CATCH_UP_MS,
  dozoHoldRoutine,
  dozoInQuietHours,
  dozoQuietHoursEnd,
  readDozoQuietHours,
  saveDozoQuietHours,
} from "./dozo-quiet-hours.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { wakeRoutine } from "./run-routines.js";

const HOUR = 60 * 60_000;
const NIGHT = { startMinute: 22 * 60, endMinute: 7 * 60 };

describe("quiet hours", () => {
  it("cover a range across midnight, start included and end not", () => {
    const at = (iso: string) => dozoInQuietHours(NIGHT, new Date(iso), "UTC");
    expect(at("2026-11-20T21:59:00Z")).toBe(false);
    expect(at("2026-11-20T22:00:00Z")).toBe(true);
    expect(at("2026-11-21T03:00:00Z")).toBe(true);
    expect(at("2026-11-21T07:00:00Z")).toBe(false);
  });

  it("cover a range inside one day", () => {
    const lunch = { startMinute: 12 * 60, endMinute: 13 * 60 + 30 };
    expect(dozoInQuietHours(lunch, new Date("2026-11-20T11:59:00Z"), "UTC")).toBe(false);
    expect(dozoInQuietHours(lunch, new Date("2026-11-20T13:29:00Z"), "UTC")).toBe(true);
    expect(dozoInQuietHours(lunch, new Date("2026-11-20T13:30:00Z"), "UTC")).toBe(false);
  });

  it("are read in the given zone, and in UTC for a zone that does not exist", () => {
    // 23:30 in Istanbul (UTC+3) is 20:30 UTC.
    const at = new Date("2026-11-20T20:30:00Z");
    expect(dozoInQuietHours(NIGHT, at, "Europe/Istanbul")).toBe(true);
    expect(dozoInQuietHours(NIGHT, at, "Not/AZone")).toBe(false);
  });

  it("end at the first minute outside them", () => {
    expect(dozoQuietHoursEnd(NIGHT, new Date("2026-11-20T23:15:30Z"), "UTC")).toEqual(
      new Date("2026-11-21T07:00:00Z"),
    );
    expect(dozoQuietHoursEnd(NIGHT, new Date("2026-11-20T23:00:00Z"), "Europe/Istanbul")).toEqual(
      new Date("2026-11-21T04:00:00Z"),
    );
  });

  it("end after the gap when a clock change skips their end", () => {
    // Berlin skips 02:00-03:00 on 29 March 2026; an end at 02:30 becomes 03:00 local (01:00 UTC).
    const early = { startMinute: 0, endMinute: 2 * 60 + 30 };
    expect(dozoQuietHoursEnd(early, new Date("2026-03-28T23:30:00Z"), "Europe/Berlin")).toEqual(
      new Date("2026-03-29T01:00:00Z"),
    );
  });

  it("give up after a day when a range never ends", () => {
    const always = { startMinute: 60, endMinute: 60 };
    expect(dozoQuietHoursEnd(always, new Date("2026-11-20T10:00:00Z"), "UTC")).toEqual(
      new Date("2026-11-21T10:01:00Z"),
    );
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
type Hold = { dueAt: Date; heldUntil: Date };

/** The rows the module reads and writes, behind the few calls it makes. */
function fakeDatabase() {
  const routines = new Map<string, Routine>();
  const holds = new Map<string, Hold>();
  const quiet = new Map<string, { startMinute: number; endMinute: number }>();
  const users = new Map<string, { timezone: string | null }>();
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const client = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql(strings);
      if (text.includes('FROM "user" u')) {
        const [routineId, userId] = values as [string, string];
        const user = users.get(userId);
        if (!user) return [];
        const hold = holds.get(routineId);
        const hours = quiet.get(userId);
        return [
          {
            dueAt: hold?.dueAt ?? null,
            heldUntil: hold?.heldUntil ?? null,
            startMinute: hours?.startMinute ?? null,
            endMinute: hours?.endMinute ?? null,
            timezone: user.timezone,
          },
        ];
      }
      if (text.includes("FROM dozo_quiet_hours")) {
        const hours = quiet.get(values[0] as string);
        return hours ? [hours] : [];
      }
      if (text.includes("FROM dozo_routine_holds h JOIN")) {
        return [...holds.entries()].flatMap(([routineId, hold]) => {
          const routine = routines.get(routineId);
          return routine?.userId === values[0] && routine.active && hold.heldUntil > new Date()
            ? [{ routineId, spaceId: routine.spaceId, ...hold }]
            : [];
        });
      }
      throw new Error(`unexpected query: ${text}`);
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql(strings);
      if (text.includes("INSERT INTO dozo_quiet_hours")) {
        const [userId, startMinute, endMinute] = values as [string, number, number];
        quiet.set(userId, { startMinute, endMinute });
      } else if (text.includes("DELETE FROM dozo_quiet_hours")) {
        quiet.delete(values[0] as string);
      } else if (text.includes("INSERT INTO dozo_routine_holds")) {
        const [routineId, dueAt, heldUntil] = values as [string, Date, Date];
        holds.set(routineId, { dueAt, heldUntil });
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
  return { routines, holds, quiet, users, deps, enqueued, publishSpaceChange, addRoutine };
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
    db.quiet.set("user-1", NIGHT);
    const routine = db.addRoutine({ nextRunAt: NOW });
    const prisma = db.deps.prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> };
    prisma.$queryRaw.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(false);
    expect(routine.nextRunAt).toEqual(NOW);
  });

  it("waits until quiet hours end, remembering when it was due", async () => {
    const db = fakeDatabase();
    db.quiet.set("user-1", NIGHT);
    const routine = db.addRoutine({ nextRunAt: NOW });
    const end = new Date("2026-11-21T07:00:00Z");
    expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(true);
    expect(routine.nextRunAt).toEqual(end);
    expect(db.holds.get("routine-1")).toEqual({ dueAt: NOW, heldUntil: end });
    expect(db.enqueued).toEqual([
      expect.objectContaining({
        name: "routine.wakeup",
        payload: { routineId: "routine-1", scheduledFor: end.toISOString() },
        availableAt: end,
      }),
    ]);
    expect(db.publishSpaceChange).toHaveBeenCalledWith("space-1", "routines");
  });

  it("reads quiet hours in the owner's zone before the routine's", async () => {
    const db = fakeDatabase();
    db.quiet.set("user-1", NIGHT);
    // 23:00 UTC is 15:00 in Los Angeles: not quiet there, though it is in UTC.
    db.users.set("user-1", { timezone: "America/Los_Angeles" });
    const routine = db.addRoutine({ nextRunAt: NOW });
    expect(await dozoHoldRoutine(db.deps, routine, NOW, vi.fn())).toBe(false);
  });

  it("does nothing when the schedule moved before it could wait", async () => {
    const db = fakeDatabase();
    db.quiet.set("user-1", NIGHT);
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
    db.holds.set("routine-1", { dueAt: due, heldUntil: end });
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
    db.holds.set("routine-1", { dueAt: NOW, heldUntil: end });
    const wake = vi.fn(async () => undefined);
    expect(await dozoHoldRoutine(db.deps, routine, end, wake)).toBe(true);
    expect(wake).not.toHaveBeenCalled();
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
    db.holds.set("routine-1", { dueAt: due, heldUntil: end });
    expect(await dozoHoldRoutine(db.deps, routine, due, vi.fn())).toBe(false);
  });

  it("waits from the routine wakeup itself", async () => {
    const db = fakeDatabase();
    db.quiet.set("user-1", NIGHT);
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
  it("reads nothing before they are set", async () => {
    const db = fakeDatabase();
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toBeNull();
  });

  it("sets, changes and clears them", async () => {
    const db = fakeDatabase();
    await saveDozoQuietHours(db.deps, "user-1", NIGHT);
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toEqual(NIGHT);
    await saveDozoQuietHours(db.deps, "user-1", null);
    expect(await readDozoQuietHours(db.deps.prisma, "user-1")).toBeNull();
    expect(db.enqueued).toEqual([]);
  });

  it("sends routines waiting on the old hours back to when they were due", async () => {
    const db = fakeDatabase();
    const due = new Date(Date.now() - HOUR);
    const end = new Date(Date.now() + 5 * HOUR);
    const waiting = db.addRoutine({ id: "waiting", nextRunAt: end });
    db.holds.set("waiting", { dueAt: due, heldUntil: end });
    // Edited since it was held: it keeps its new schedule.
    const edited = db.addRoutine({ id: "edited", spaceId: "space-2", nextRunAt: due });
    db.holds.set("edited", { dueAt: due, heldUntil: end });
    // Another account's routine.
    db.addRoutine({ id: "theirs", userId: "user-2", nextRunAt: end });
    db.holds.set("theirs", { dueAt: due, heldUntil: end });

    await saveDozoQuietHours(db.deps, "user-1", null);

    expect(waiting.nextRunAt).toEqual(due);
    expect(edited.nextRunAt).toEqual(due);
    expect(db.routines.get("theirs")?.nextRunAt).toEqual(end);
    expect(db.enqueued).toEqual([
      expect.objectContaining({
        payload: { routineId: "waiting", scheduledFor: due.toISOString() },
      }),
    ]);
    expect(db.publishSpaceChange).toHaveBeenCalledExactlyOnceWith("space-1", "routines");
  });
});
