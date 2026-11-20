import type { Actor } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoMessagePinRoutes, listPins, readableThread, setPin } from "./dozo-message-pins.js";
import type { RouterContext } from "./routes/context.js";

const mocks = vi.hoisted(() => ({ resolveThreadTarget: vi.fn() }));
vi.mock("./thread-target.js", () => ({ resolveThreadTarget: mocks.resolveThreadTarget }));

const actor: Actor = { userId: "user-me", spaceId: "space-1", email: "me@example.test" } as Actor;

type Sql = { text: string; values: unknown[] };
const sql = (strings: TemplateStringsArray, values: unknown[]): Sql => ({
  text: strings.join("?").replace(/\s+/g, " ").trim(),
  values,
});

function fakeDb(
  options: {
    thread?: { botId: string | null; groupId: string | null } | null;
    pinned?: string[];
    messages?: Array<{ id: string; role: string; botId: string | null; blocks: unknown }>;
  } = {},
) {
  const statements: Sql[] = [];
  const db = {
    thread: {
      findFirst: vi.fn(async () =>
        options.thread === undefined ? { botId: "bot-1", groupId: null } : options.thread,
      ),
    },
    message: {
      findMany: vi.fn(async () => options.messages ?? []),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        (options.messages ?? []).some((message) => message.id === where.id)
          ? { id: where.id }
          : null,
      ),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(sql(strings, values));
      return (options.pinned ?? []).map((messageId) => ({ messageId }));
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(sql(strings, values));
      return 1;
    }),
  };
  return { db, statements };
}

const text = (value: string) => [{ kind: "text", text: value }];

beforeEach(() => {
  mocks.resolveThreadTarget.mockReset();
  mocks.resolveThreadTarget.mockResolvedValue({ kind: "bot", threadId: "thread-1" });
});

describe("readableThread", () => {
  it("checks a bot's chat with the bot's own access rules, archived included", async () => {
    const { db } = fakeDb();
    await readableThread(db as never, actor, "thread-1");
    expect(db.thread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "thread-1", spaceId: "space-1" } }),
    );
    expect(mocks.resolveThreadTarget).toHaveBeenCalledWith(
      db,
      actor,
      { botId: "bot-1" },
      { includeArchived: true },
    );
  });

  it("checks a group chat through its group", async () => {
    const { db } = fakeDb({ thread: { botId: null, groupId: "group-1" } });
    await readableThread(db as never, actor, "thread-1");
    expect(mocks.resolveThreadTarget).toHaveBeenCalledWith(
      db,
      actor,
      { groupId: "group-1" },
      { includeArchived: true },
    );
  });

  it.each([
    ["a chat in another Space", null],
    ["a helper's or chat app's conversation", { botId: null, groupId: null }],
  ])("refuses %s", async (_name, thread) => {
    const { db } = fakeDb({ thread });
    await expect(readableThread(db as never, actor, "thread-1")).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(mocks.resolveThreadTarget).not.toHaveBeenCalled();
  });

  it("refuses a chat that is not the target's own", async () => {
    mocks.resolveThreadTarget.mockResolvedValue({ kind: "bot", threadId: "thread-other" });
    const { db } = fakeDb();
    await expect(readableThread(db as never, actor, "thread-1")).rejects.toBeInstanceOf(
      IsolationError,
    );
  });
});

describe("listPins", () => {
  it("reads nothing more when the caller has no pins", async () => {
    const { db, statements } = fakeDb();
    expect(await listPins(db as never, actor, "thread-1")).toEqual([]);
    expect(statements[0]?.values).toEqual(["user-me", "thread-1", 50]);
    expect(db.message.findMany).not.toHaveBeenCalled();
  });

  it("keeps the pin order and shows each message as a reply quote does", async () => {
    const { db } = fakeDb({
      pinned: ["m-new", "m-gone", "m-old"],
      messages: [
        { id: "m-old", role: "user", botId: null, blocks: text("Plan dinner") },
        { id: "m-new", role: "bot", botId: "bot-1", blocks: text("Pasta.") },
      ],
    });
    expect(await listPins(db as never, actor, "thread-1")).toEqual([
      { messageId: "m-new", preview: { role: "bot", botId: "bot-1", text: "Pasta." } },
      { messageId: "m-old", preview: { role: "user", text: "Plan dinner" } },
    ]);
    expect(db.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "thread-1", id: { in: ["m-new", "m-gone", "m-old"] } },
      }),
    );
  });

  it("leaves out a message whose role it does not know", async () => {
    const { db } = fakeDb({
      pinned: ["m-1"],
      messages: [{ id: "m-1", role: "tool", botId: null, blocks: text("x") }],
    });
    expect(await listPins(db as never, actor, "thread-1")).toEqual([]);
  });
});

describe("setPin", () => {
  const messages = [{ id: "m-1", role: "bot", botId: "bot-1", blocks: text("Pasta.") }];

  it("pins a message of the chat once, then keeps only the newest pins", async () => {
    const { db, statements } = fakeDb({ messages });
    await setPin(db as never, actor, { threadId: "thread-1", messageId: "m-1", pinned: true });
    expect(statements).toHaveLength(2);
    expect(statements[0]?.text).toContain("INSERT INTO dozo_message_pins");
    expect(statements[0]?.text).toContain('ON CONFLICT ("userId", "messageId") DO NOTHING');
    expect(statements[0]?.values).toEqual(["user-me", "space-1", "m-1", "thread-1"]);
    expect(statements[1]?.text).toContain("DELETE FROM dozo_message_pins");
    expect(statements[1]?.values).toEqual(["user-me", "thread-1", "user-me", "thread-1", 50]);
  });

  it("refuses a message that is not in the chat", async () => {
    const { db, statements } = fakeDb({ messages });
    await expect(
      setPin(db as never, actor, { threadId: "thread-1", messageId: "m-x", pinned: true }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(statements).toEqual([]);
  });

  it("unpins only the caller's own pin in that chat", async () => {
    const { db, statements } = fakeDb();
    await setPin(db as never, actor, { threadId: "thread-1", messageId: "m-1", pinned: false });
    expect(db.message.findFirst).not.toHaveBeenCalled();
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toContain("DELETE FROM dozo_message_pins");
    expect(statements[0]?.values).toEqual(["user-me", "thread-1", "m-1"]);
  });
});

describe("dozoMessagePinRoutes", () => {
  type Handler = (args: { context: { actor: Actor }; input: Record<string, unknown> }) => unknown;

  function setup(options: Parameters<typeof fakeDb>[0] = {}) {
    const { db, statements } = fakeDb(options);
    const publishRosterChange = vi.fn(async () => undefined);
    const authed = {
      dozoMessages: {
        pins: { handler: (handler: Handler) => handler },
        pin: { handler: (handler: Handler) => handler },
      },
    };
    const routes = dozoMessagePinRoutes({
      deps: { prisma: db, events: { publishRosterChange } },
      authed,
    } as unknown as RouterContext) as unknown as Record<string, Handler>;
    const call = (name: string, input: Record<string, unknown>) =>
      routes[name]!({ context: { actor }, input });
    return { call, publishRosterChange, statements };
  }

  it("lists the caller's pins in a chat they can read", async () => {
    const { call } = setup({
      pinned: ["m-1"],
      messages: [{ id: "m-1", role: "bot", botId: "bot-1", blocks: text("Pasta.") }],
    });
    expect(await call("pins", { threadId: "thread-1" })).toEqual({
      pins: [{ messageId: "m-1", preview: { role: "bot", botId: "bot-1", text: "Pasta." } }],
    });
  });

  it("signals only the caller's own apps after a pin change", async () => {
    const { call, publishRosterChange } = setup({
      messages: [{ id: "m-1", role: "bot", botId: "bot-1", blocks: text("Pasta.") }],
    });
    expect(await call("pin", { threadId: "thread-1", messageId: "m-1", pinned: true })).toEqual({
      pinned: true,
    });
    expect(publishRosterChange).toHaveBeenCalledWith({ userIds: ["user-me"] });
  });

  it("changes nothing and signals nothing in a chat the caller cannot read", async () => {
    mocks.resolveThreadTarget.mockRejectedValue(new IsolationError());
    const { call, publishRosterChange, statements } = setup();
    await expect(
      call("pin", { threadId: "thread-1", messageId: "m-1", pinned: false }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(call("pins", { threadId: "thread-1" })).rejects.toBeInstanceOf(IsolationError);
    expect(statements).toEqual([]);
    expect(publishRosterChange).not.toHaveBeenCalled();
  });
});
