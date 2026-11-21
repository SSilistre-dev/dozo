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
  dozoBotChats,
  listChats,
  renameChat,
} from "./dozo-bot-chats.js";

const mocks = vi.hoisted(() => ({ resolveThreadTarget: vi.fn() }));
vi.mock("./thread-target.js", () => ({ resolveThreadTarget: mocks.resolveThreadTarget }));

const actor = { userId: "user-me", spaceId: "space-1", email: "me@example.test" } as Actor;
const createdAt = new Date("2026-11-21T10:00:00.000Z");

type Sql = { text: string; values: unknown[] };
type Row = {
  threadId: string;
  botId: string;
  name: string;
  createdAt: Date;
  archivedAt: Date | null;
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
      },
    ]);
    expect(statements[0]?.values).toEqual(["bot-1", "space-1", false]);
    expect(statements[0]?.text).toContain("AT TIME ZONE 'UTC'");
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
