import type { Actor } from "@rakazo/contracts";
import {
  DOZO_BOT_CHATS_LIMIT_CODE,
  DOZO_BOT_CHATS_MAX,
  DOZO_BOT_CHATS_TOTAL_LIMIT_CODE,
  DOZO_BOT_CHATS_TOTAL_MAX,
  DozoBotChatName,
} from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveChat,
  createChat,
  DozoBotChatsLimitError,
  dozoBotChatRoutes,
  dozoBotChats,
  dozoImportChat,
  listChats,
  renameChat,
} from "./dozo-bot-chats.js";
import type { RouterContext } from "./routes/context.js";

const mocks = vi.hoisted(() => ({ resolveThreadTarget: vi.fn(), stopThreadRuns: vi.fn() }));
vi.mock("./thread-target.js", () => ({ resolveThreadTarget: mocks.resolveThreadTarget }));
vi.mock("./thread-stop.js", () => ({ stopThreadRuns: mocks.stopThreadRuns }));

const actor = { userId: "user-me", spaceId: "space-1", email: "me@example.test" } as Actor;
const createdAt = new Date("2026-11-21T10:00:00.000Z");

type Sql = { text: string; values: unknown[] };
type Row = {
  threadId: string;
  botId: string;
  name: string;
  createdAt: Date;
  archivedAt: Date | null;
  unread?: boolean | null;
  snoozedUntil?: Date | null;
};

/** Answers SQL as the table would for one chat, and counts open chats as `open`. */
function fakeDb(
  options: { row?: Row | null; open?: number; total?: number; botGone?: boolean } = {},
) {
  const statements: Sql[] = [];
  let row = options.row === undefined ? null : options.row;
  const record = (strings: TemplateStringsArray, values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push({ text, values });
    return text;
  };
  const db = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = record(strings, values);
      if (text.startsWith("SELECT count(*)"))
        return [{ open: options.open ?? 0, total: options.total ?? options.open ?? 0 }];
      if (text.includes("FOR NO KEY UPDATE")) return options.botGone ? [] : [{ id: values[0] }];
      return row ? [row] : [];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = record(strings, values);
      if (text.startsWith("INSERT")) {
        row = {
          threadId: values[0] as string,
          botId: values[1] as string,
          name: values[3] as string,
          createdAt,
          archivedAt: null,
        };
      } else if (text.includes("SET name") && row) row = { ...row, name: values[0] as string };
      else if (text.includes("archivedAt") && row)
        row = { ...row, archivedAt: values[0] ? createdAt : null };
      return 1;
    }),
    thread: { create: vi.fn(async () => ({ id: "thread-new" })) },
  };
  return { db, statements };
}

const chat = (overrides: Partial<Row> = {}): Row => ({
  threadId: "thread-2",
  botId: "bot-1",
  name: "Garden",
  createdAt,
  archivedAt: null,
  ...overrides,
});

beforeEach(() => {
  mocks.resolveThreadTarget.mockReset();
  mocks.resolveThreadTarget.mockResolvedValue({ kind: "bot", threadId: "thread-main" });
});

describe("DozoBotChatName", () => {
  it("trims a name and refuses an empty, overlong or multi-line one", () => {
    expect(DozoBotChatName.parse("  Garden ")).toBe("Garden");
    for (const name of ["", "   ", "x".repeat(81), "a\nb", "a\tb"]) {
      expect(DozoBotChatName.safeParse(name).success, JSON.stringify(name)).toBe(false);
    }
  });
});

describe("listChats", () => {
  it("reads the bot's chats in the caller's Space only, open ones unless asked", async () => {
    const { db, statements } = fakeDb({ row: chat() });
    expect(await listChats(db as never, actor, "bot-1", false)).toEqual([
      {
        id: "thread-2",
        botId: "bot-1",
        name: "Garden",
        createdAt: "2026-11-21T10:00:00.000Z",
        archivedAt: null,
        unread: false,
        snoozedUntil: null,
      },
    ]);
    expect(statements[0]?.values).toEqual(["user-me", "space-1", "bot-1", "bot-1", "bot-1", false]);
    expect(statements[0]?.text).toContain("AT TIME ZONE 'UTC'");
  });

  it("reads every bot's chats with the caller's own read state when no bot is named", async () => {
    const snoozedUntil = new Date("2026-11-22T08:00:00.000Z");
    const { db, statements } = fakeDb({ row: chat({ unread: true, snoozedUntil }) });
    const [listed] = await listChats(db as never, actor, undefined, true);
    expect(listed).toMatchObject({ unread: true, snoozedUntil: "2026-11-22T08:00:00.000Z" });
    expect(statements[0]?.values).toEqual(["user-me", "space-1", null, null, null, true]);
  });
});

describe("createChat", () => {
  it("adds a thread with no bot on it and the chat's row, under the bot's lock", async () => {
    const { db, statements } = fakeDb();
    const made = await createChat(db as never, actor, { botId: "bot-1", name: "Garden" });
    expect(db.thread.create).toHaveBeenCalledWith({
      data: { spaceId: "space-1", userId: "user-me" },
      select: { id: true },
    });
    expect(made).toMatchObject({ id: "thread-new", botId: "bot-1", name: "Garden" });
    expect(statements[0]?.text).toContain("FOR NO KEY UPDATE");
  });

  it("refuses a bot archived or deleted since the caller's check", async () => {
    const { db } = fakeDb({ botGone: true });
    await expect(
      createChat(db as never, actor, { botId: "bot-1", name: "Garden" }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(db.thread.create).not.toHaveBeenCalled();
  });

  it("refuses past the most open chats a bot holds, with a stable code", async () => {
    const { db } = fakeDb({ open: DOZO_BOT_CHATS_MAX });
    const refused = createChat(db as never, actor, { botId: "bot-1", name: "Garden" });
    await expect(refused).rejects.toBeInstanceOf(DozoBotChatsLimitError);
    await expect(refused).rejects.toMatchObject({
      kind: "CONFLICT",
      code: DOZO_BOT_CHATS_LIMIT_CODE,
    });
    expect(db.thread.create).not.toHaveBeenCalled();
  });

  it("refuses past the most chats a bot holds in all, archived ones included", async () => {
    const { db } = fakeDb({ open: 0, total: DOZO_BOT_CHATS_TOTAL_MAX });
    await expect(
      createChat(db as never, actor, { botId: "bot-1", name: "Garden" }),
    ).rejects.toMatchObject({ kind: "CONFLICT", code: DOZO_BOT_CHATS_TOTAL_LIMIT_CODE });
    // Bringing one back adds no row, so only the open limit applies to it.
    const back = fakeDb({
      row: chat({ archivedAt: createdAt }),
      open: 0,
      total: DOZO_BOT_CHATS_TOTAL_MAX,
    });
    const chatBack = await archiveChat(back.db as never, actor, {
      chatId: "thread-2",
      archived: false,
    });
    expect(chatBack.archivedAt).toBeNull();
  });
});

describe("renameChat and archiveChat", () => {
  it("renames a chat of the Space and refuses one it cannot find", async () => {
    const { db } = fakeDb({ row: chat() });
    expect((await renameChat(db as never, actor, { chatId: "thread-2", name: "Taxes" })).name).toBe(
      "Taxes",
    );
    const missing = fakeDb({ row: null }).db;
    await expect(
      renameChat(missing as never, actor, { chatId: "nope", name: "Taxes" }),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("changes nothing when the chat is already as asked", async () => {
    const { db } = fakeDb({ row: chat({ archivedAt: createdAt }) });
    await archiveChat(db as never, actor, { chatId: "thread-2", archived: true });
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("archives freely, and brings one back only while there is room", async () => {
    const open = fakeDb({ row: chat(), open: DOZO_BOT_CHATS_MAX });
    const archived = await archiveChat(open.db as never, actor, {
      chatId: "thread-2",
      archived: true,
    });
    expect(archived.archivedAt).toBe("2026-11-21T10:00:00.000Z");
    const full = fakeDb({ row: chat({ archivedAt: createdAt }), open: DOZO_BOT_CHATS_MAX });
    await expect(
      archiveChat(full.db as never, actor, { chatId: "thread-2", archived: false }),
    ).rejects.toBeInstanceOf(DozoBotChatsLimitError);
    const room = fakeDb({ row: chat({ archivedAt: createdAt }), open: 1 });
    const back = await archiveChat(room.db as never, actor, {
      chatId: "thread-2",
      archived: false,
    });
    expect(back.archivedAt).toBeNull();
  });
});

describe("dozoBotChats", () => {
  function service(db: ReturnType<typeof fakeDb>["db"]) {
    const publishRosterChange = vi.fn(async () => undefined);
    const prisma = {
      ...db,
      $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
    };
    const chats = dozoBotChats({
      prisma,
      events: { publishRosterChange },
    } as unknown as Parameters<typeof dozoBotChats>[0]);
    return { chats, publishRosterChange };
  }

  it("checks the bot as for its main chat, archived bots included only for the list", async () => {
    const { chats } = service(fakeDb({ row: chat() }).db);
    expect((await chats.list(actor, { botId: "bot-1" })).chats).toHaveLength(1);
    expect(mocks.resolveThreadTarget).toHaveBeenLastCalledWith(
      expect.anything(),
      actor,
      { botId: "bot-1" },
      { includeArchived: true },
    );
    await chats.create(actor, { botId: "bot-1", name: "Garden" });
    expect(mocks.resolveThreadTarget).toHaveBeenLastCalledWith(expect.anything(), actor, {
      botId: "bot-1",
    });
  });

  it("stops the chat's working turn before archiving it, and nothing when bringing it back", async () => {
    mocks.stopThreadRuns.mockReset().mockResolvedValue(undefined);
    const { chats } = service(fakeDb({ row: chat() }).db);
    await chats.archive(actor, { chatId: "thread-2", archived: true });
    expect(mocks.resolveThreadTarget).toHaveBeenLastCalledWith(expect.anything(), actor, {
      chatBotId: "bot-1",
      chatId: "thread-2",
    });
    expect(mocks.stopThreadRuns).toHaveBeenCalledTimes(1);
    const back = service(fakeDb({ row: chat({ archivedAt: createdAt }) }).db);
    await back.chats.archive(actor, { chatId: "thread-2", archived: false });
    // Archiving an archived chat again is a no-op: nothing to stop there.
    const again = service(fakeDb({ row: chat({ archivedAt: createdAt }) }).db);
    await again.chats.archive(actor, { chatId: "thread-2", archived: true });
    expect(mocks.stopThreadRuns).toHaveBeenCalledTimes(1);
  });

  it("lists every chat of the Space without checking one bot", async () => {
    const { chats } = service(fakeDb({ row: chat() }).db);
    expect((await chats.list(actor, {})).chats).toHaveLength(1);
    expect(mocks.resolveThreadTarget).not.toHaveBeenCalled();
  });

  it("checks the chat's own bot before a change and signals the Space after it", async () => {
    const { chats, publishRosterChange } = service(fakeDb({ row: chat({ botId: "bot-9" }) }).db);
    await chats.rename(actor, { chatId: "thread-2", name: "Taxes" });
    expect(mocks.resolveThreadTarget).toHaveBeenLastCalledWith(expect.anything(), actor, {
      botId: "bot-9",
    });
    expect(publishRosterChange).toHaveBeenCalledWith({ spaceIds: ["space-1"] });
    mocks.resolveThreadTarget.mockRejectedValueOnce(new IsolationError());
    await expect(
      chats.archive(actor, { chatId: "thread-2", archived: true }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(publishRosterChange).toHaveBeenCalledTimes(1);
  });
});

describe("dozoBotChatRoutes", () => {
  it("answers each route with the service, as the caller", async () => {
    const procedure = () => ({
      handler: (fn: (options: unknown) => unknown) => ({ call: fn }),
    });
    const db = fakeDb({ row: chat() }).db;
    const prisma = {
      ...db,
      $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
      routine: {
        findFirst: vi.fn(async () => ({ id: "routine-1", botId: "bot-1", threadId: null })),
        update: vi.fn(async () => ({})),
      },
    };
    const routes = dozoBotChatRoutes({
      deps: { prisma, events: {} },
      authed: {
        dozoChats: {
          list: procedure(),
          create: procedure(),
          rename: procedure(),
          archive: procedure(),
          routineChat: procedure(),
          setRoutineChat: procedure(),
        },
      },
    } as unknown as RouterContext).dozoChats as unknown as Record<
      string,
      { call: (options: unknown) => Promise<unknown> }
    >;
    const context = { actor };
    expect(await routes.list!.call({ context, input: {} })).toMatchObject({
      chats: [{ id: "thread-2" }],
    });
    expect(
      await routes.create!.call({ context, input: { botId: "bot-1", name: "Garden" } }),
    ).toMatchObject({ chat: { name: "Garden" } });
    expect(
      await routes.rename!.call({ context, input: { chatId: "thread-2", name: "Taxes" } }),
    ).toMatchObject({ chat: { name: "Taxes" } });
    expect(
      await routes.archive!.call({ context, input: { chatId: "thread-new", archived: true } }),
    ).toMatchObject({ chat: { id: "thread-new" } });
    expect(await routes.routineChat!.call({ context, input: { routineId: "routine-1" } })).toEqual({
      chatId: null,
      editable: true,
    });
    expect(
      await routes.setRoutineChat!.call({
        context,
        input: { routineId: "routine-1", chatId: null },
      }),
    ).toEqual({ chatId: null, editable: true });
  });
});

describe("where a routine posts", () => {
  type Chat = { botId: string; spaceId: string; name: string; archived: boolean };
  /** A routine of bot-1 posting in `threadId`, and the Space's extra chats by thread. */
  function service(threadId: string | null, chats: Record<string, Chat> = {}, found = true) {
    const update = vi.fn(async () => ({}));
    const publishSpaceChange = vi.fn(async () => undefined);
    const prisma = {
      routine: {
        findFirst: vi.fn(async () =>
          found ? { id: "routine-1", botId: "bot-1", threadId } : null,
        ),
        update,
      },
      $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const [thread, botId, spaceId] = values as string[];
        const chat = chats[thread];
        return chat && chat.botId === botId && chat.spaceId === spaceId
          ? [{ name: chat.name, archived: chat.archived }]
          : [];
      }),
    };
    const chatsService = dozoBotChats({
      prisma,
      events: { publishSpaceChange },
    } as unknown as Parameters<typeof dozoBotChats>[0]);
    return { chats: chatsService, prisma, update, publishSpaceChange };
  }
  const garden: Chat = { botId: "bot-1", spaceId: "space-1", name: "Garden", archived: false };
  const old: Chat = { ...garden, name: "Old", archived: true };
  const trails: Chat = { ...garden, botId: "bot-2", name: "Trails" };
  const space = { garden, old, trails, elsewhere: { ...garden, spaceId: "space-2" } };

  it("reads a routine of a bot the caller may chat with, in the caller's Space", async () => {
    const { chats, prisma } = service(null);
    expect(await chats.routineChat(actor, { routineId: "routine-1" })).toEqual({
      chatId: null,
      editable: true,
    });
    expect(prisma.routine.findFirst).toHaveBeenCalledWith({
      where: { id: "routine-1", spaceId: "space-1", bot: { archivedAt: null } },
      select: { id: true, botId: true, threadId: true },
    });
    expect(mocks.resolveThreadTarget).toHaveBeenCalledWith(expect.anything(), actor, {
      botId: "bot-1",
    });
    await expect(
      service(null, {}, false).chats.routineChat(actor, { routineId: "routine-9" }),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("names the open extra chat it posts in, and the main chat for any other", async () => {
    const read = (threadId: string | null) =>
      service(threadId, space).chats.routineChat(actor, { routineId: "routine-1" });
    expect(await read("garden")).toEqual({ chatId: "garden", editable: true });
    expect(await read("thread-main")).toEqual({ chatId: null, editable: true });
    // Archived: it runs in the main chat, so that is what it shows.
    expect(await read("old")).toEqual({ chatId: null, editable: true });
    // A group's routine, or any thread that is not this bot's chat, is not the bot's to move.
    expect(await read("group-thread")).toEqual({ chatId: null, editable: false });
    expect(await read("trails")).toEqual({ chatId: null, editable: false });
  });

  it("points a routine at an open extra chat of its bot or back at the main chat, and signals", async () => {
    const one = service(null, space);
    expect(
      await one.chats.setRoutineChat(actor, { routineId: "routine-1", chatId: "garden" }),
    ).toEqual({ chatId: "garden", editable: true });
    expect(one.update).toHaveBeenCalledWith({
      where: { id: "routine-1" },
      data: { threadId: "garden" },
    });
    expect(one.publishSpaceChange).toHaveBeenCalledWith("space-1", "routines");
    const back = service("garden", space);
    await back.chats.setRoutineChat(actor, { routineId: "routine-1", chatId: null });
    expect(back.update).toHaveBeenCalledWith({
      where: { id: "routine-1" },
      data: { threadId: null },
    });
  });

  it("refuses any chat that cannot take it as not found, changing nothing", async () => {
    for (const chatId of ["old", "trails", "elsewhere", "missing", "thread-main"]) {
      const { chats, update } = service(null, space);
      await expect(
        chats.setRoutineChat(actor, { routineId: "routine-1", chatId }),
      ).rejects.toBeInstanceOf(IsolationError);
      expect(update).not.toHaveBeenCalled();
    }
    const group = service("group-thread", space);
    await expect(
      group.chats.setRoutineChat(actor, { routineId: "routine-1", chatId: null }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(group.update).not.toHaveBeenCalled();
    mocks.resolveThreadTarget.mockRejectedValueOnce(new IsolationError());
    const notMine = service(null, space);
    await expect(
      notMine.chats.setRoutineChat(actor, { routineId: "routine-1", chatId: "garden" }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(notMine.update).not.toHaveBeenCalled();
  });
});

describe("dozoImportChat", () => {
  it("writes the chat's thread and row in one transaction, with the archive's times", async () => {
    const { db, statements } = fakeDb();
    const prisma = { $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)) };
    const id = await dozoImportChat(prisma as never, {
      spaceId: "space-1",
      userId: "user-me",
      botId: "bot-1",
      chat: { name: "Garden", archivedAt: "2026-11-20T10:00:00.000Z" },
      thread: {
        historyCompactedUpToSeq: 4,
        historyCompactionSummary: "Talked about tomatoes.",
        createdAt: "2026-11-01T09:00:00.000Z",
      },
    });
    expect(id).toBe("thread-new");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(db.thread.create).toHaveBeenCalledWith({
      data: {
        spaceId: "space-1",
        userId: "user-me",
        historyCompactedUpToSeq: 4,
        historyCompactionSummary: "Talked about tomatoes.",
        createdAt: new Date("2026-11-01T09:00:00.000Z"),
      },
      select: { id: true },
    });
    const insert = statements.find((statement) => statement.text.startsWith("INSERT"));
    expect(insert?.values).toEqual([
      "thread-new",
      "bot-1",
      "space-1",
      "Garden",
      "2026-11-01T09:00:00.000Z",
      "2026-11-20T10:00:00.000Z",
    ]);
    await dozoImportChat(prisma as never, {
      spaceId: "space-1",
      userId: "user-me",
      botId: "bot-1",
      chat: { name: "Open", archivedAt: null },
      thread: {
        historyCompactedUpToSeq: null,
        historyCompactionSummary: null,
        createdAt: "2026-11-01T09:00:00.000Z",
      },
    });
    expect(
      statements
        .filter((statement) => statement.text.startsWith("INSERT"))
        .at(-1)
        ?.values.at(-1),
    ).toBeNull();
  });
});

describe("dozoImportChat's limits", () => {
  const input = (archivedAt: string | null) => ({
    spaceId: "space-1",
    userId: "user-me",
    botId: "bot-1",
    chat: { name: "Garden", archivedAt },
    thread: {
      historyCompactedUpToSeq: null,
      historyCompactionSummary: null,
      createdAt: "2026-11-01T09:00:00.000Z",
    },
  });
  const importing = (db: ReturnType<typeof fakeDb>["db"], archivedAt: string | null) =>
    dozoImportChat(
      { $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)) } as never,
      input(archivedAt),
    );

  it("holds an archive to the most open chats a bot holds, archived ones aside", async () => {
    const full = fakeDb({ open: DOZO_BOT_CHATS_MAX, total: DOZO_BOT_CHATS_MAX });
    await expect(importing(full.db, null)).rejects.toMatchObject({
      code: DOZO_BOT_CHATS_LIMIT_CODE,
    });
    expect(full.db.thread.create).not.toHaveBeenCalled();
    expect(await importing(full.db, "2026-11-20T10:00:00.000Z")).toBe("thread-new");
  });

  it("holds an archive to the most chats a bot holds in all", async () => {
    const full = fakeDb({ open: 0, total: DOZO_BOT_CHATS_TOTAL_MAX });
    await expect(importing(full.db, "2026-11-20T10:00:00.000Z")).rejects.toMatchObject({
      code: DOZO_BOT_CHATS_TOTAL_LIMIT_CODE,
    });
    expect(full.db.thread.create).not.toHaveBeenCalled();
  });
});
