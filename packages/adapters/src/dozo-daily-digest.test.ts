import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  messages: [] as Array<{ threadId: string; text: string; clientNonce?: string }>,
  events: [] as Array<{ type: string; threadId: string }>,
}));

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  runAsSystem: (_why: string, work: () => unknown) => work(),
  createThreadMessageInTransaction: async (
    _tx: unknown,
    input: { threadId: string; blocks: Array<{ text: string }>; clientNonce?: string },
  ) => {
    db.messages.push({
      threadId: input.threadId,
      text: input.blocks[0]?.text ?? "",
      clientNonce: input.clientNonce,
    });
    return { id: `message-${db.messages.length}` };
  },
  appendEventInTransaction: async (_tx: unknown, input: { type: string; threadId: string }) => {
    db.events.push(input);
    return { seq: db.events.length };
  },
}));

import type { DozoDigestContent } from "./dozo-daily-digest.js";
import {
  collectDozoDigest,
  dozoDigestCron,
  dozoDigestMinute,
  dozoSendDailyDigest,
  formatDozoDigest,
  readDozoDailyDigest,
  saveDozoDailyDigest,
} from "./dozo-daily-digest.js";
import { DOZO_DIGEST_ROUTINE_PROMPT } from "./dozo-daily-digest.prompt.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { wakeRoutine } from "./run-routines.js";

const HOUR = 60 * 60_000;
// 08:00 in Istanbul (UTC+3).
const DUE = new Date("2026-11-21T05:00:00Z");
const EMPTY: DozoDigestContent = { yesterday: [], waiting: [], today: [] };

type Routine = {
  id: string;
  spaceId: string;
  botId: string;
  userId: string;
  name: string;
  prompt: string;
  crons: string[];
  timezone: string;
  active: boolean;
  nextRunAt: Date | null;
  lastRunAt?: Date | null;
  watch: unknown;
  threadId: string | null;
};

function fakeDatabase() {
  const routines = new Map<string, Routine>();
  const digests = new Map<string, string>();
  const users = new Map([["user-1", { timezone: "Europe/Istanbul", locale: "tr" }]]);
  const bots = new Map([
    ["bot-1", { id: "bot-1", name: "Ada", spaceId: "space-1" }],
    ["bot-2", { id: "bot-2", name: "Bo*b", spaceId: "space-1" }],
  ]);
  const groupBy = vi.fn(async (_args: unknown): Promise<unknown[]> => []);
  const findManyRoutines = vi.fn(async (_args: unknown): Promise<unknown[]> => []);
  let created = 0;
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const client = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql(strings);
      if (text.includes('JOIN "user" u ON u.id = d."userId"')) {
        const [routineId, userId] = values as [string, string];
        return digests.get(userId) === routineId
          ? [{ locale: users.get(userId)?.locale ?? null }]
          : [];
      }
      if (text.includes('FROM "user" WHERE id = ? FOR UPDATE')) return [{ id: values[0] }];
      if (text.includes("JOIN routines r ON r.id")) {
        const routine = routines.get(digests.get(values[0] as string) ?? "");
        if (!routine) return [];
        return [
          {
            routineId: routine.id,
            botId: routine.botId,
            botName: bots.get(routine.botId)?.name,
            spaceId: routine.spaceId,
            crons: routine.crons,
            active: routine.active,
          },
        ];
      }
      if (text.includes('FROM "user" u')) {
        return [
          { dueAt: null, heldUntil: null, startMinute: null, endMinute: null, timezone: null },
        ];
      }
      throw new Error(`unexpected query: ${text}`);
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!sql(strings).includes("INSERT INTO dozo_daily_digest")) throw new Error("unexpected");
      digests.set(values[0] as string, values[1] as string);
      return 1;
    }),
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const user = users.get(where.id);
        return user ? { ...user, deactivatedAt: null } : null;
      }),
    },
    bot: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        ...bots.get(where.id),
        archivedAt: null,
        thread: { id: `thread-${where.id}` },
      })),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => {
          const bot = bots.get(id);
          return bot ? [bot] : [];
        }),
      ),
    },
    run: { groupBy },
    routine: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const routine = routines.get(where.id);
        return routine && { ...routine, space: { deletingAt: null } };
      }),
      findMany: findManyRoutines,
      create: vi.fn(async ({ data }: { data: Omit<Routine, "id" | "watch" | "threadId"> }) => {
        created += 1;
        const row = { ...data, id: `created-${created}`, watch: null, threadId: null };
        routines.set(row.id, row);
        return { id: row.id };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Routine> }) => {
        Object.assign(routines.get(where.id) ?? {}, data);
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        routines.delete(where.id);
        for (const [userId, routineId] of digests)
          if (routineId === where.id) digests.delete(userId);
        return { count: 1 };
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
  const notify = vi.fn(async () => undefined);
  const publishSpaceChange = vi.fn(async () => undefined);
  const deps = {
    prisma: client as unknown as PrismaClient,
    jobs,
    events: { notify, publishSpaceChange, append: vi.fn(async () => undefined) },
  };
  const addDigest = (overrides: Partial<Routine> = {}) => {
    const routine: Routine = {
      id: "digest-1",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      name: "Günlük özet",
      prompt: DOZO_DIGEST_ROUTINE_PROMPT,
      crons: ["0 8 * * *"],
      timezone: "Europe/Istanbul",
      active: true,
      nextRunAt: DUE,
      watch: null,
      threadId: null,
      ...overrides,
    };
    routines.set(routine.id, routine);
    digests.set(routine.userId, routine.id);
    return routine;
  };
  return {
    deps,
    routines,
    digests,
    users,
    groupBy,
    findManyRoutines,
    enqueued,
    cancelled,
    notify,
    publishSpaceChange,
    addDigest,
  };
}

beforeEach(() => {
  db.messages.length = 0;
  db.events.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DUE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("digest schedule", () => {
  it("writes a daily cron and reads its minute back", () => {
    expect(dozoDigestCron(8 * 60 + 30)).toBe("30 8 * * *");
    expect(dozoDigestMinute(["30 8 * * *"])).toBe(8 * 60 + 30);
    expect(dozoDigestMinute(["0 0 * * *"])).toBe(0);
  });

  it("reads no minute from a schedule edited into another shape", () => {
    expect(dozoDigestMinute(["0 8 * * 1-5"])).toBeNull();
    expect(dozoDigestMinute(["0 8 * * *", "0 20 * * *"])).toBeNull();
    expect(dozoDigestMinute(["75 8 * * *"])).toBeNull();
    expect(dozoDigestMinute(["0 24 * * *"])).toBeNull();
  });
});

describe("digest text", () => {
  const content: DozoDigestContent = {
    yesterday: [
      { bot: "Ada", done: 3, failed: 1 },
      { bot: "Bo*b", done: 0, failed: 2 },
    ],
    waiting: [{ bot: "Ada", count: 2 }],
    today: [{ at: new Date("2026-11-21T09:00:00Z"), bot: "Ada", name: "News  [scan]" }],
  };

  it("says nothing on an empty day", () => {
    expect(formatDozoDigest(EMPTY, { locale: "en", timeZone: "UTC" })).toBeNull();
  });

  it("lists each part in the account's language and timezone", () => {
    expect(formatDozoDigest(content, { locale: "tr", timeZone: "Europe/Istanbul" })).toBe(
      [
        "**Dün**",
        "- Ada: 3 bitti, 1 başarısız",
        "- Bo\\*b: 2 başarısız",
        "",
        "**Sizi bekleyenler**",
        "- Ada: 2",
        "",
        "**Bugün**",
        "- 12:00 · Ada · News \\[scan\\]",
      ].join("\n"),
    );
  });

  it("falls back to English and leaves out empty parts", () => {
    expect(
      formatDozoDigest({ ...EMPTY, waiting: content.waiting }, { locale: null, timeZone: "UTC" }),
    ).toBe("**Waiting for you**\n- Ada: 2");
  });

  it("caps a long list", () => {
    const today = Array.from({ length: 7 }, (_, index) => ({
      at: new Date(Date.UTC(2026, 10, 21, 9, index)),
      bot: "Ada",
      name: `Routine ${index + 1}`,
    }));
    const text = formatDozoDigest({ ...EMPTY, today }, { locale: "en", timeZone: "UTC" });
    expect(text?.split("\n")).toHaveLength(1 + 5 + 1);
    expect(text?.endsWith("- 2 more")).toBe(true);
  });
});

describe("collecting a digest", () => {
  it("reads the account's own work in the local day before and the rest of today", async () => {
    const fake = fakeDatabase();
    fake.groupBy
      .mockResolvedValueOnce([
        { botId: "bot-1", status: "completed", _count: { _all: 3 } },
        { botId: "bot-1", status: "failed", _count: { _all: 1 } },
        { botId: "bot-2", status: "completed", _count: { _all: 5 } },
        { botId: "gone", status: "completed", _count: { _all: 9 } },
      ])
      .mockResolvedValueOnce([
        { botId: "bot-1", _count: { _all: 1 } },
        { botId: "bot-2", _count: { _all: 2 } },
        { botId: "gone", _count: { _all: 1 } },
      ]);
    fake.findManyRoutines.mockResolvedValueOnce([
      { name: "News", botId: "bot-2", nextRunAt: new Date("2026-11-21T09:00:00Z") },
      { name: "Lost", botId: "gone", nextRunAt: new Date("2026-11-21T10:00:00Z") },
    ]);
    const content = await collectDozoDigest(fake.deps.prisma, {
      userId: "user-1",
      spaceId: "space-1",
      at: DUE,
      timeZone: "Europe/Istanbul",
      digestRoutineId: "digest-1",
    });
    expect(content).toEqual({
      yesterday: [
        { bot: "Bo*b", done: 5, failed: 0 },
        { bot: "Ada", done: 3, failed: 1 },
      ],
      waiting: [
        { bot: "Bo*b", count: 2 },
        { bot: "Ada", count: 1 },
      ],
      today: [{ at: new Date("2026-11-21T09:00:00Z"), bot: "Bo*b", name: "News" }],
    });
    // Istanbul's 20 November runs from 21:00 UTC on the 19th to 21:00 UTC on the 20th.
    const finished = fake.groupBy.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(finished.where).toMatchObject({
      userId: "user-1",
      spaceId: "space-1",
      createdAt: { gte: new Date("2026-11-19T21:00:00Z"), lt: new Date("2026-11-20T21:00:00Z") },
    });
    const due = fake.findManyRoutines.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(due.where).toMatchObject({
      id: { not: "digest-1" },
      nextRunAt: { gte: DUE, lt: new Date("2026-11-21T21:00:00Z") },
    });
  });

  it("asks for no bot names when there is nothing", async () => {
    const fake = fakeDatabase();
    const content = await collectDozoDigest(fake.deps.prisma, {
      userId: "user-1",
      spaceId: "space-1",
      at: DUE,
      timeZone: "UTC",
      digestRoutineId: "digest-1",
    });
    expect(content).toEqual(EMPTY);
    expect(fake.deps.prisma.bot.findMany).not.toHaveBeenCalled();
  });
});

describe("saving the digest", () => {
  it("reads nothing before it is turned on", async () => {
    const fake = fakeDatabase();
    expect(await readDozoDailyDigest(fake.deps.prisma, "user-1")).toBeNull();
  });

  it("turns on as a routine in the bot's Space, in the account's timezone and language", async () => {
    const fake = fakeDatabase();
    await saveDozoDailyDigest(fake.deps, "user-1", {
      botId: "bot-1",
      minute: 9 * 60,
      spaceId: "space-1",
    });
    const routine = fake.routines.get("created-1");
    expect(routine).toMatchObject({
      botId: "bot-1",
      spaceId: "space-1",
      name: "Günlük özet",
      crons: ["0 9 * * *"],
      timezone: "Europe/Istanbul",
      active: true,
      nextRunAt: new Date("2026-11-21T06:00:00Z"),
    });
    expect(fake.enqueued).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ routineId: "created-1" }) }),
    ]);
    expect(fake.publishSpaceChange).toHaveBeenCalledWith("space-1", "routines");
    expect(await readDozoDailyDigest(fake.deps.prisma, "user-1")).toEqual({
      botId: "bot-1",
      botName: "Ada",
      minute: 9 * 60,
    });
  });

  it("moves the same routine to a new time", async () => {
    const fake = fakeDatabase();
    fake.addDigest();
    await saveDozoDailyDigest(fake.deps, "user-1", {
      botId: "bot-1",
      minute: 20 * 60,
      spaceId: "space-1",
    });
    expect(fake.routines.get("digest-1")).toMatchObject({
      crons: ["0 20 * * *"],
      nextRunAt: new Date("2026-11-21T17:00:00Z"),
    });
    expect(fake.cancelled).toEqual([]);
  });

  it("replaces the routine for another bot and drops the old wakeup", async () => {
    const fake = fakeDatabase();
    fake.addDigest();
    fake.users.set("user-1", { timezone: "Europe/Istanbul", locale: "en" });
    await saveDozoDailyDigest(fake.deps, "user-1", {
      botId: "bot-2",
      minute: 8 * 60,
      spaceId: "space-1",
    });
    expect(fake.routines.has("digest-1")).toBe(false);
    expect(fake.routines.get("created-1")).toMatchObject({ botId: "bot-2", name: "Daily digest" });
    expect(fake.digests.get("user-1")).toBe("created-1");
    expect(fake.cancelled).toHaveLength(1);
  });

  it("turns off by deleting its routine", async () => {
    const fake = fakeDatabase();
    fake.addDigest();
    await saveDozoDailyDigest(fake.deps, "user-1", null);
    expect(fake.routines.size).toBe(0);
    expect(fake.enqueued).toEqual([]);
    expect(await readDozoDailyDigest(fake.deps.prisma, "user-1")).toBeNull();
  });

  it("reads a paused routine as off", async () => {
    const fake = fakeDatabase();
    fake.addDigest({ active: false });
    expect(await readDozoDailyDigest(fake.deps.prisma, "user-1")).toBeNull();
  });
});

describe("sending the digest", () => {
  const send = (fake: ReturnType<typeof fakeDatabase>, routine: Routine) =>
    dozoSendDailyDigest(fake.deps, routine, { id: "bot-1" }, { id: "thread-1" }, DUE);

  it("leaves every other routine alone", async () => {
    const fake = fakeDatabase();
    const routine = fake.addDigest();
    fake.digests.clear();
    expect(await send(fake, routine)).toBe(false);
    expect(fake.routines.get("digest-1")?.nextRunAt).toEqual(DUE);
  });

  it("looks nothing up for a routine that asks for something else", async () => {
    const fake = fakeDatabase();
    const routine = fake.addDigest({ prompt: "Check the news" });
    expect(await send(fake, routine)).toBe(false);
    expect(fake.deps.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("writes one message without a model run and wakes again tomorrow", async () => {
    const fake = fakeDatabase();
    const routine = fake.addDigest();
    fake.groupBy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ botId: "bot-1", _count: { _all: 1 } }]);
    expect(await send(fake, routine)).toBe(true);
    expect(db.messages).toEqual([
      {
        threadId: "thread-1",
        text: "**Sizi bekleyenler**\n- Ada: 1",
        clientNonce: `dozo-digest:digest-1:${DUE.toISOString()}`,
      },
    ]);
    expect(db.events).toEqual([
      expect.objectContaining({ type: "thread.message.created", threadId: "thread-1" }),
    ]);
    expect(fake.notify).toHaveBeenCalledWith("thread-1", 1);
    const next = new Date(DUE.getTime() + 24 * HOUR);
    expect(fake.routines.get("digest-1")).toMatchObject({ nextRunAt: next, lastRunAt: DUE });
    expect(fake.enqueued).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ routineId: "digest-1" }) }),
    ]);
  });

  it("writes nothing on an empty day and still moves on", async () => {
    const fake = fakeDatabase();
    const routine = fake.addDigest();
    expect(await send(fake, routine)).toBe(true);
    expect(db.messages).toEqual([]);
    expect(fake.notify).not.toHaveBeenCalled();
    expect(fake.routines.get("digest-1")?.nextRunAt).toEqual(new Date(DUE.getTime() + 24 * HOUR));
  });

  it("writes nothing for an occurrence another wake already took", async () => {
    const fake = fakeDatabase();
    const routine = fake.addDigest({ nextRunAt: new Date(DUE.getTime() + 24 * HOUR) });
    fake.groupBy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ botId: "bot-1", _count: { _all: 1 } }]);
    expect(await send(fake, routine)).toBe(true);
    expect(db.messages).toEqual([]);
  });

  it("ends a schedule that no longer parses", async () => {
    const fake = fakeDatabase();
    const routine = fake.addDigest({ crons: ["not a cron"] });
    expect(await send(fake, routine)).toBe(true);
    expect(fake.routines.get("digest-1")).toMatchObject({ active: false, nextRunAt: null });
    expect(fake.enqueued).toEqual([]);
  });

  it("is what a due digest routine does instead of starting a run", async () => {
    const fake = fakeDatabase();
    fake.addDigest();
    fake.groupBy.mockResolvedValueOnce([
      { botId: "bot-1", status: "completed", _count: { _all: 2 } },
    ]);
    await wakeRoutine(fake.deps as unknown as ExecutorDeps, "digest-1", DUE.toISOString());
    expect(db.messages.map((message) => message.text)).toEqual(["**Dün**\n- Ada: 2 bitti"]);
    expect(db.messages[0]?.threadId).toBe("thread-bot-1");
  });
});
