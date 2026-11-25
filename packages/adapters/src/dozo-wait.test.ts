import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./tools/builtin.tool-definition.js";
import { DOZO_ROUTINE_CATCH_UP_MS } from "./dozo-quiet-hours.js";
import {
  DOZO_MAX_WAITS_PER_BOT,
  dozoCreateSchedule,
  dozoTickWait,
  dozoWaitRefusal,
  dozoWatchNextRunAt,
} from "./dozo-wait.js";
import { DOZO_WAIT_MAX_MINUTES } from "./dozo-wait.tool-definition.js";
import type { ExecutorDeps } from "./runs/executor/executor-deps.js";
import { parseConnectorToolArgs } from "./tools/lazy-tool-catalog.js";
import { normalizeOpenAiToolParameters } from "./models/endpoints/openai-tool-parameters.js";
import type { tickRoutineWatch } from "./routines/routine-watch.js";
import type { RunContext } from "./runs/assembly/run-context.js";
import { wakeRoutine } from "./runs/assembly/run-routines.js";
import { scheduleCreateRefusal } from "./runs/tools/run-tools-tasks.js";
import type { createScheduleFromTool } from "./tools/schedule-tools.js";

const MINUTE = 60_000;
const NOW = new Date("2026-11-21T10:00:00Z");
const WATCH = { kind: "http", url: "https://status.example.test/deploy" };

type Wait = { endsAt: Date; minutes: number };
type Routine = { id: string; active: boolean; nextRunAt: Date | null };

/** The rows the module reads and writes, behind the few calls it makes. */
function fakeDatabase() {
  const waits = new Map<string, Wait>();
  const routines = new Map<string, Routine & { botId: string }>();
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  let failInsert = false;
  const lockedFor: string[] = [];
  const client = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql(strings);
      if (text.includes("count(*)")) {
        const waiting = [...waits.keys()].filter((id) => {
          const routine = routines.get(id);
          return routine !== undefined && routine.botId === values[0] && routine.active;
        });
        return [{ waits: waiting.length }];
      }
      if (text.includes("pg_advisory_xact_lock")) {
        lockedFor.push(values[0] as string);
        return [];
      }
      if (text.includes("FROM dozo_routine_waits WHERE")) {
        const wait = waits.get(values[0] as string);
        return wait ? [wait] : [];
      }
      throw new Error(`unexpected query: ${text}`);
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!sql(strings).includes("INSERT INTO dozo_routine_waits")) throw new Error("unexpected");
      if (failInsert) throw new Error("database is away");
      const [routineId, endsAt, minutes] = values as [string, string, number];
      waits.set(routineId, { endsAt: new Date(endsAt), minutes });
      return 1;
    }),
    routine: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; active?: boolean; nextRunAt?: Date | { gt: Date } };
          data: Partial<Routine>;
        }) => {
          const routine = routines.get(where.id);
          if (!routine || (where.active !== undefined && routine.active !== where.active))
            return { count: 0 };
          const next = routine.nextRunAt?.getTime() ?? Number.NaN;
          if (where.nextRunAt instanceof Date && next !== where.nextRunAt.getTime())
            return { count: 0 };
          if (where.nextRunAt && "gt" in where.nextRunAt && !(next > where.nextRunAt.gt.getTime()))
            return { count: 0 };
          Object.assign(routine, data);
          return { count: 1 };
        },
      ),
    },
  };
  Object.assign(client, {
    $transaction: async <T>(work: (tx: typeof client) => Promise<T>) => work(client),
  });
  const enqueued: BackgroundJob[] = [];
  const cancelled: string[] = [];
  const jobs: JobPublisher = {
    enqueue: vi.fn(async (job: BackgroundJob) => {
      enqueued.push(job);
    }),
    enqueueIn: async () => undefined,
    cancelIn: async () => undefined,
    cancel: vi.fn(async (key: string) => {
      cancelled.push(key);
    }),
    close: async () => undefined,
  };
  const publishSpaceChange = vi.fn(async () => undefined);
  const deps = {
    prisma: client as unknown as PrismaClient,
    jobs,
    events: { publishSpaceChange },
  };
  const addRoutine = (row: Partial<Routine> & { id: string }) => {
    const routine = { active: true, nextRunAt: NOW, botId: "bot-1", ...row };
    routines.set(routine.id, routine);
    return routine;
  };
  return {
    waits,
    routines,
    deps,
    enqueued,
    cancelled,
    publishSpaceChange,
    addRoutine,
    lockedFor,
    failInserts: () => {
      failInsert = true;
    },
  };
}

type Db = ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("schedule_create's wait", () => {
  const schema = () =>
    builtinAgentTools.find((entry) => entry.name === "schedule_create")?.inputSchema ?? {};

  it("is offered on a watch only, with its limits", () => {
    const branches = (
      schema() as { oneOf: Array<{ required: string[]; properties: Record<string, unknown> }> }
    ).oneOf;
    const watch = branches.find((branch) => branch.required.includes("watch"));
    expect(watch?.properties.waitMinutes).toMatchObject({
      type: "number",
      minimum: 5,
      maximum: DOZO_WAIT_MAX_MINUTES,
    });
    for (const branch of branches.filter((entry) => entry !== watch))
      expect(JSON.stringify(branch.properties.waitMinutes)).toContain('"null"');
  });

  it("accepts a watch with waitMinutes, and null leftovers on a timed reminder", () => {
    expect(
      parseConnectorToolArgs(schema(), {
        name: "Deploy",
        prompt: "Report the deploy",
        watch: WATCH,
        waitMinutes: 60,
      }),
    ).toMatchObject({ waitMinutes: 60 });
    expect(
      parseConnectorToolArgs(schema(), {
        name: "Call",
        prompt: "Remind me to call",
        delayMinutes: 20,
        waitMinutes: null,
      }),
    ).toMatchObject({ delayMinutes: 20 });
    expect(() =>
      parseConnectorToolArgs(schema(), {
        name: "Call",
        prompt: "Remind me to call",
        delayMinutes: 20,
        waitMinutes: 60,
      }),
    ).toThrow(/invalid/i);
    const wire = normalizeOpenAiToolParameters(schema());
    expect(JSON.stringify((wire.properties as Record<string, unknown>).waitMinutes)).toContain(
      '"null"',
    );
  });
});

const input = {
  spaceId: "space-1",
  botId: "bot-1",
  userId: "user-1",
  threadId: "thread-1",
  name: "Deploy",
  prompt: "Report the deploy",
  schedule: { watch: WATCH },
};

function creator(db: Db) {
  let next = 0;
  return vi.fn(async () => {
    next += 1;
    const id = `routine-${next}`;
    db.addRoutine({ id, nextRunAt: new Date(NOW.getTime() + 2_000) });
    return {
      ok: true as const,
      routineId: id,
      name: "Deploy",
      watch: WATCH,
      note: "Takes a first reading now.",
    };
  }) as unknown as typeof createScheduleFromTool & ReturnType<typeof vi.fn>;
}

describe("creating a wait", () => {
  const deps = (db: Db) => db.deps as unknown as Parameters<typeof createScheduleFromTool>[0];

  it("leaves schedule_create alone without waitMinutes", async () => {
    const db = fakeDatabase();
    const create = creator(db);
    for (const blank of [undefined, null, " "]) {
      const created = await dozoCreateSchedule(create, blank, deps(db), input);
      expect(created).not.toHaveProperty("waitEndsAt");
    }
    expect(create).toHaveBeenCalledTimes(3);
    expect(db.waits.size).toBe(0);
  });

  it("records the deadline and tells the bot to end its turn", async () => {
    const db = fakeDatabase();
    const created = await dozoCreateSchedule(creator(db), 90, deps(db), input);
    const end = new Date(NOW.getTime() + 90 * MINUTE);
    expect(created).toMatchObject({ ok: true, waitEndsAt: end.toISOString() });
    expect(created).toHaveProperty("note", expect.stringMatching(/End your turn/));
    expect(db.waits.get("routine-1")).toEqual({ endsAt: end, minutes: 90 });
  });

  it("refuses a length out of range, a wait without a watch, and one past the limit", async () => {
    const db = fakeDatabase();
    const create = creator(db);
    for (const minutes of [2, DOZO_WAIT_MAX_MINUTES + 1, "soon"])
      expect(await dozoCreateSchedule(create, minutes, deps(db), input)).toEqual({
        error: `waitMinutes must be 5 to ${DOZO_WAIT_MAX_MINUTES} minutes.`,
      });
    const timed = { ...input, schedule: { delayMinutes: 20 } };
    expect(await dozoCreateSchedule(create, 30, deps(db), timed)).toHaveProperty(
      "error",
      expect.stringMatching(/goes with a watch/),
    );
    expect(create).not.toHaveBeenCalled();

    for (let wait = 0; wait < DOZO_MAX_WAITS_PER_BOT; wait += 1)
      await dozoCreateSchedule(create, 30, deps(db), input);
    // An ended wait no longer counts.
    const ended = db.routines.get("routine-1");
    if (ended) ended.active = false;
    expect(await dozoCreateSchedule(create, 30, deps(db), input)).toHaveProperty("ok", true);
    expect(await dozoCreateSchedule(create, 30, deps(db), input)).toHaveProperty(
      "error",
      expect.stringMatching(/already have 10 waits/),
    );
    // A wait for another bot counts against that bot.
    const other = { ...input, target: { botId: "bot-2", threadId: "thread-2" } };
    expect(await dozoCreateSchedule(create, 30, deps(db), other)).toHaveProperty("ok", true);
  });

  it("refuses before the approval card what the call itself would refuse", async () => {
    const db = fakeDatabase();
    const refusal = (minutes: unknown, watch: unknown = WATCH, botId = "bot-1") =>
      dozoWaitRefusal(db.deps.prisma, minutes, { botId, watch });
    expect(await refusal(undefined)).toBeUndefined();
    expect(await refusal(null, undefined)).toBeUndefined();
    expect(await refusal(60)).toBeUndefined();
    expect(await refusal(1)).toMatch(/must be 5 to/);
    expect(await refusal(60, null)).toMatch(/goes with a watch/);
    expect(await refusal(60, "")).toMatch(/goes with a watch/);
    for (let wait = 0; wait < DOZO_MAX_WAITS_PER_BOT; wait += 1) {
      db.addRoutine({ id: `full-${wait}` });
      db.waits.set(`full-${wait}`, { endsAt: NOW, minutes: 30 });
    }
    expect(await refusal(60)).toMatch(/already have 10 waits/);
    expect(await refusal(60, WATCH, "bot-2")).toBeUndefined();
  });

  it("is asked before schedule_create's approval card", async () => {
    const db = fakeDatabase();
    Object.assign(db.deps.prisma, {
      routine: { ...db.deps.prisma.routine, findMany: async () => [] },
    });
    const ctx = {
      deps: db.deps,
      run: { spaceId: "space-1", userId: "user-1" },
      bot: { id: "bot-1" },
      thread: { id: "thread-1" },
      computer: { graphical: false },
    } as unknown as RunContext;
    const args = { name: "Deploy", prompt: "Report the deploy", watch: WATCH };
    expect(await scheduleCreateRefusal(ctx, args)).toBeUndefined();
    expect(await scheduleCreateRefusal(ctx, { ...args, waitMinutes: 2 })).toEqual({
      error: `waitMinutes must be 5 to ${DOZO_WAIT_MAX_MINUTES} minutes.`,
    });
  });

  it("counts again under the bot's lock, so a call that lost the race takes its watch back", async () => {
    const db = fakeDatabase();
    for (let wait = 0; wait < DOZO_MAX_WAITS_PER_BOT - 1; wait += 1) {
      db.addRoutine({ id: `other-${wait}` });
      db.waits.set(`other-${wait}`, { endsAt: NOW, minutes: 30 });
    }
    // Another call records the last wait while this one creates its routine.
    const create = vi.fn(async () => {
      db.addRoutine({ id: "rival" });
      db.waits.set("rival", { endsAt: NOW, minutes: 30 });
      db.addRoutine({ id: "routine-1", nextRunAt: new Date(NOW.getTime() + 2_000) });
      return { ok: true as const, routineId: "routine-1", name: "Deploy", watch: WATCH, note: "" };
    }) as unknown as typeof createScheduleFromTool;
    expect(await dozoCreateSchedule(create, 30, deps(db), input)).toHaveProperty(
      "error",
      expect.stringMatching(/already have 10 waits/),
    );
    expect(db.lockedFor).toEqual(["dozo-wait:bot-1"]);
    expect(db.waits.has("routine-1")).toBe(false);
    expect(db.routines.get("routine-1")).toMatchObject({ active: false, nextRunAt: null });
    expect(db.cancelled).toEqual(["routine:routine-1"]);
  });

  it("passes on what schedule_create refuses", async () => {
    const db = fakeDatabase();
    const create = vi.fn(async () => ({
      error: "Bot not found.",
    })) as unknown as typeof createScheduleFromTool;
    expect(await dozoCreateSchedule(create, 30, deps(db), input)).toEqual({
      error: "Bot not found.",
    });
    expect(db.waits.size).toBe(0);
  });

  it("takes the watch back when the wait cannot be recorded", async () => {
    const db = fakeDatabase();
    db.failInserts();
    expect(await dozoCreateSchedule(creator(db), 30, deps(db), input)).toEqual({
      error: "Could not start the wait. Try again.",
    });
    expect(db.routines.get("routine-1")).toMatchObject({ active: false, nextRunAt: null });
    expect(db.cancelled).toEqual(["routine:routine-1"]);
    expect(db.publishSpaceChange).toHaveBeenCalledWith("space-1", "routines");
  });
});

describe("a wait's wake", () => {
  const routine = {
    id: "routine-1",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    name: "Deploy",
    watch: { ...WATCH, everyMinutes: 15, loud: false },
    watchState: null,
  };
  const target = { threadId: "thread-1", botId: "bot-1" };
  type TickDeps = Parameters<typeof tickRoutineWatch>[0];
  const wake = (db: Db, tick: typeof tickRoutineWatch, at = NOW) =>
    dozoTickWait(tick, db.deps as unknown as TickDeps, routine, target, at);
  const quiet = (db: Db, nextRunAt: Date) =>
    vi.fn(async () => {
      const row = db.routines.get("routine-1");
      if (row) row.nextRunAt = nextRunAt;
      return { run: false as const };
    }) as unknown as typeof tickRoutineWatch & ReturnType<typeof vi.fn>;
  const changed = vi.fn(async () => ({
    run: true as const,
    state: {
      checkedAt: NOW.toISOString(),
      outcome: "changed" as const,
      fingerprint: "b",
      detail: "New",
    },
    nextRunAt: new Date(NOW.getTime() + 15 * MINUTE),
    note: "\n\nThis run was started because something you watch changed (HTTPS endpoint).",
  })) as unknown as typeof tickRoutineWatch;

  it("checks a routine that is no wait as always", async () => {
    const db = fakeDatabase();
    db.addRoutine({ id: "routine-1" });
    const tick = await wake(db, changed);
    expect(tick).not.toHaveProperty("ends");
    expect(tick.run && dozoWatchNextRunAt(tick)).toEqual(new Date(NOW.getTime() + 15 * MINUTE));
  });

  it("ends with the run the first change starts", async () => {
    const db = fakeDatabase();
    db.addRoutine({ id: "routine-1" });
    db.waits.set("routine-1", { endsAt: new Date(NOW.getTime() + 60 * MINUTE), minutes: 60 });
    const tick = await wake(db, changed);
    expect(tick).toMatchObject({ run: true, ends: true });
    expect(tick.run && tick.note).toMatch(
      /changed \(HTTPS endpoint\)[\s\S]*one-time wait; it has ended/,
    );
    expect(tick.run && dozoWatchNextRunAt(tick)).toBeNull();
  });

  it("wakes at the deadline when the next check would come after it", async () => {
    const db = fakeDatabase();
    db.addRoutine({ id: "routine-1" });
    const endsAt = new Date(NOW.getTime() + 10 * MINUTE);
    db.waits.set("routine-1", { endsAt, minutes: 60 });
    expect(await wake(db, quiet(db, new Date(NOW.getTime() + 15 * MINUTE)))).toEqual({
      run: false,
    });
    expect(db.routines.get("routine-1")?.nextRunAt).toEqual(endsAt);
    expect(db.enqueued).toEqual([
      expect.objectContaining({ name: "routine.wakeup", availableAt: endsAt }),
    ]);

    // A check that comes before the deadline keeps its time.
    const early = new Date(NOW.getTime() + 5 * MINUTE);
    await wake(db, quiet(db, early));
    expect(db.routines.get("routine-1")?.nextRunAt).toEqual(early);
    expect(db.enqueued).toHaveLength(1);
  });

  it("runs once at the deadline, without a check, to say nothing changed", async () => {
    const db = fakeDatabase();
    db.addRoutine({ id: "routine-1" });
    db.waits.set("routine-1", { endsAt: NOW, minutes: 45 });
    const tick = vi.fn() as unknown as typeof tickRoutineWatch;
    const result = await wake(db, tick);
    expect(tick).not.toHaveBeenCalled();
    expect(result).toMatchObject({ run: true, ends: true, state: { outcome: "unchanged" } });
    expect(result.run && result.note).toMatch(
      /wait on HTTPS endpoint ended after 45 minutes without a change/,
    );
    expect(result.run && dozoWatchNextRunAt(result)).toBeNull();

    const seen = {
      checkedAt: "2026-11-21T09:50:00.000Z",
      outcome: "unchanged",
      fingerprint: "a",
      detail: null,
    };
    const withState = await dozoTickWait(
      tick,
      db.deps as unknown as TickDeps,
      { ...routine, watch: { kind: "unknown" }, watchState: seen },
      target,
      NOW,
    );
    expect(withState).toMatchObject({ run: true, state: seen });
    expect(withState.run && withState.note).toMatch(/wait on a watch ended/);
  });

  it("ends without a run when its deadline was missed by more than the catch-up window", async () => {
    const db = fakeDatabase();
    const endsAt = new Date(NOW.getTime() - DOZO_ROUTINE_CATCH_UP_MS - MINUTE);
    db.addRoutine({ id: "routine-1", nextRunAt: endsAt });
    db.waits.set("routine-1", { endsAt, minutes: 30 });
    expect(await wake(db, changed, endsAt)).toEqual({ run: false });
    expect(db.routines.get("routine-1")).toMatchObject({ active: false, nextRunAt: null });
    expect(db.publishSpaceChange).toHaveBeenCalledWith("space-1", "routines");

    // A wake that lost the race to another ends nothing twice.
    db.publishSpaceChange.mockClear();
    expect(await wake(db, changed, endsAt)).toEqual({ run: false });
    expect(db.publishSpaceChange).not.toHaveBeenCalled();
  });
});

describe("a wait woken by its routine", () => {
  /** Just the rows wakeRoutine reads and writes for one watching routine. */
  function routineDatabase(wait: Wait) {
    const routine = {
      id: "routine-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      threadId: "thread-1",
      name: "Deploy",
      prompt: "Report the deploy",
      crons: [] as string[],
      timezone: "UTC",
      watch: { ...WATCH, everyMinutes: 15, loud: false },
      watchState: null,
      active: true,
      nextRunAt: wait.endsAt as Date | null,
      lastRunAt: null as Date | null,
    };
    const runs: Array<Record<string, unknown>> = [];
    const client = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray | object) => {
        const text = Array.isArray(strings) ? strings.join("?") : "";
        if (text.includes("FROM dozo_routine_waits")) return [wait];
        if (text.includes('FROM "user" u'))
          return [
            { dueAt: null, heldUntil: null, startMinute: null, endMinute: null, timezone: null },
          ];
        return [];
      }),
      user: { findUnique: async () => ({ deactivatedAt: null }) },
      bot: {
        findUnique: async () => ({ id: "bot-1", archivedAt: null, thread: { id: "thread-0" } }),
      },
      thread: { findFirst: async () => ({ id: "thread-1" }) },
      agentSkill: { findMany: async () => [] },
      space: { findUnique: async () => ({ deletingAt: null }) },
      routine: {
        findUnique: async () => ({ ...routine, space: { deletingAt: null } }),
        updateMany: async ({ where, data }: { where: { nextRunAt?: Date }; data: object }) => {
          if (!routine.active || routine.nextRunAt?.getTime() !== where.nextRunAt?.getTime())
            return { count: 0 };
          Object.assign(routine, data);
          return { count: 1 };
        },
      },
      task: { create: async () => ({ id: "task-1" }) },
      run: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          runs.push(data);
          return { id: "run-1", ...data };
        },
      },
      $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(client),
    };
    const enqueued: BackgroundJob[] = [];
    const deps = {
      prisma: client,
      jobs: {
        enqueue: async (job: BackgroundJob) => {
          enqueued.push(job);
        },
        cancel: async () => undefined,
      },
      events: {
        append: vi.fn(async () => ({ seq: 1 })),
        notify: async () => undefined,
        publishSpaceChange: async () => undefined,
      },
    };
    return { routine, runs, enqueued, deps };
  }

  it("starts one run in the chat it was asked in at its deadline, and ends", async () => {
    const db = routineDatabase({ endsAt: NOW, minutes: 30 });
    await wakeRoutine(db.deps as unknown as ExecutorDeps, "routine-1", NOW.toISOString());
    expect(db.runs).toEqual([
      expect.objectContaining({ threadId: "thread-1", trigger: "routine", routineId: "routine-1" }),
    ]);
    expect(db.routine).toMatchObject({ active: false, nextRunAt: null });
    expect(db.enqueued.map((job) => job.name)).not.toContain("routine.wakeup");
  });
});
