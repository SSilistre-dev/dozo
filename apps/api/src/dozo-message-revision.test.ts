import type { Actor } from "@rakazo/contracts";
import { ClientError, MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dozoMessagesRoutes,
  loadRevisionTurn,
  MessageNotRevisableError,
  planRevision,
  reviseInTransaction,
} from "./dozo-message-revision.js";
import type { RouterContext } from "./routes/context.js";

const mocks = vi.hoisted(() => ({
  wakeRun: vi.fn(),
  modelSetup: vi.fn(),
  botsRunOwnModels: vi.fn(),
  assertTeachingSendAllowed: vi.fn(),
  resolveThreadTarget: vi.fn(),
  appendEventInTransaction: vi.fn(),
  spaceTakesWork: vi.fn(),
  loadMessageAuthor: vi.fn(),
}));

vi.mock("@rakazo/adapters", () => ({ wakeRun: mocks.wakeRun }));
vi.mock("./routes/shared.js", () => ({
  modelSetup: mocks.modelSetup,
  botsRunOwnModels: mocks.botsRunOwnModels,
}));
vi.mock("./taught-skills.js", () => ({
  assertTeachingSendAllowed: mocks.assertTeachingSendAllowed,
}));
vi.mock("./thread-target.js", () => ({ resolveThreadTarget: mocks.resolveThreadTarget }));
vi.mock("./artifacts.js", () => ({ buildSendPrompt: (text: string) => `prompt: ${text}` }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  appendEventInTransaction: mocks.appendEventInTransaction,
  spaceTakesWork: mocks.spaceTakesWork,
  loadMessageAuthor: mocks.loadMessageAuthor,
}));

const ME = "user-me";
const actor: Actor = { userId: ME, spaceId: "space-1", email: "me@example.test" } as Actor;

type Row = {
  id: string;
  seq: number;
  role: string;
  runId: string | null;
  authorUserId: string | null;
  clientNonce: string | null;
  blocks: unknown;
};
type RunRow = {
  id: string;
  sourceMessageId: string;
  status: string;
  trigger: string;
  userId: string;
  prompt: string;
  messagingMirroredAt: Date | null;
};

function chat() {
  return {
    compacted: null as number | null,
    messages: [
      {
        id: "m-old",
        seq: 3,
        role: "bot",
        runId: "r-old",
        authorUserId: null,
        clientNonce: null,
        blocks: [{ kind: "text", text: "Hello" }],
      },
      {
        id: "m-ask",
        seq: 4,
        role: "user",
        runId: "r-1",
        authorUserId: ME,
        clientNonce: "nonce-1",
        blocks: [{ kind: "text", text: "Plan dinner" }],
      },
      {
        id: "m-reply",
        seq: 5,
        role: "bot",
        runId: "r-1",
        authorUserId: null,
        clientNonce: null,
        blocks: [{ kind: "text", text: "Pasta." }],
      },
    ] as Row[],
    runs: [
      {
        id: "r-1",
        sourceMessageId: "m-ask",
        status: "completed",
        trigger: "user",
        userId: ME,
        prompt: "Plan dinner",
        messagingMirroredAt: null,
      },
    ] as RunRow[],
    active: 0,
    toolCalls: 0,
    effects: 0,
  };
}
type Chat = ReturnType<typeof chat>;

function fakeDb(state: Chat) {
  return {
    thread: {
      update: vi.fn(async () => ({ id: "thread-1", historyCompactedUpToSeq: state.compacted })),
    },
    threadRead: { updateMany: vi.fn(async () => ({ count: 1 })) },
    message: {
      findFirst: vi.fn(
        async () =>
          state.messages.filter((m) => m.role === "user").sort((a, b) => b.seq - a.seq)[0] ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { seq: { gt: number } } }) =>
        state.messages
          .filter((m) => m.seq > where.seq.gt)
          .sort((a, b) => a.seq - b.seq)
          .map(({ id, role, runId }) => ({ id, role, runId })),
      ),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    run: {
      findMany: vi.fn(async ({ where }: { where: { sourceMessageId: string } }) =>
        state.runs
          .filter((run) => run.sourceMessageId === where.sourceMessageId)
          .map(({ prompt, sourceMessageId: _, ...run }) => ({ ...run, task: { prompt } })),
      ),
      count: vi.fn(async () => state.active),
      create: vi.fn(async () => ({ id: "r-new" })),
    },
    task: { create: vi.fn(async () => ({ id: "task-new" })) },
    event: {
      count: vi.fn(async () => state.toolCalls),
      deleteMany: vi.fn(async () => ({ count: 2 })),
    },
    externalEffect: { count: vi.fn(async () => state.effects) },
  };
}
type FakeDb = ReturnType<typeof fakeDb>;

const thread = { id: "thread-1", historyCompactedUpToSeq: null };
const turnOf = (state: Chat) => loadRevisionTurn(fakeDb(state) as never, thread);

beforeEach(() => {
  vi.clearAllMocks();
  let seq = 40;
  mocks.appendEventInTransaction.mockImplementation(async () => ({ seq: ++seq }));
  mocks.spaceTakesWork.mockResolvedValue(true);
  mocks.loadMessageAuthor.mockResolvedValue({ name: "Me" });
});

describe("planRevision", () => {
  it("offers Edit on the last message and Regenerate on the last reply of a quiet turn", async () => {
    expect(planRevision(await turnOf(chat()), ME)?.revisable).toEqual({
      editMessageId: "m-ask",
      regenerateMessageId: "m-reply",
    });
  });

  it("offers nothing in an empty chat", async () => {
    const state = chat();
    state.messages = [];
    expect(await turnOf(state)).toBeNull();
    expect(planRevision(null, ME)).toBeNull();
  });

  const refusals: Array<[string, (state: Chat) => void]> = [
    ["while a run works or waits", (s) => (s.active = 1)],
    ["after a tool call, which may have acted outside the chat", (s) => (s.toolCalls = 1)],
    ["after a recorded external effect", (s) => (s.effects = 1)],
    ["for another person's message", (s) => (s.messages[1]!.authorUserId = "someone")],
    ["for a run another person started", (s) => (s.runs[0]!.userId = "someone")],
    ["for a chat-app message", (s) => (s.runs[0]!.trigger = "messaging")],
    [
      "once the reply was mirrored to a chat app",
      (s) => (s.runs[0]!.messagingMirroredAt = new Date()),
    ],
    ["before the run ends", (s) => (s.runs[0]!.status = "running")],
    ["when the message went to a run that was already working", (s) => (s.runs = [])],
    [
      "when the message woke two runs",
      (s) => s.runs.push({ ...s.runs[0]!, id: "r-2", status: "failed" }),
    ],
    [
      "for a group channel message",
      (s) => (s.messages[1]!.blocks = [{ kind: "channel_message", channelId: "c" }]),
    ],
    ["for a turn of a call", (s) => (s.messages[1]!.clientNonce = "call:abc:turn")],
    ["when the stored blocks lost entries", (s) => (s.messages[1]!.blocks = ["broken"])],
    ["once the message is in the compaction summary", (s) => (s.compacted = 4)],
    [
      "when something else was said after the reply",
      (s) =>
        s.messages.push({
          id: "m-note",
          seq: 6,
          role: "system",
          runId: null,
          authorUserId: null,
          clientNonce: null,
          blocks: [],
        }),
    ],
  ];
  it.each(refusals)("offers nothing %s", async (_, change) => {
    const state = chat();
    change(state);
    const turn = await turnOf(state);
    expect(planRevision(turn && { ...turn, compactedUpToSeq: state.compacted }, ME)).toBeNull();
  });

  it("edits only a text message and regenerates only an existing reply", async () => {
    const state = chat();
    state.messages[1]!.blocks = [
      { kind: "text", text: "Look" },
      { kind: "image", artifactId: "a" },
    ];
    state.messages.pop();
    state.runs[0]!.status = "failed";
    expect(planRevision(await turnOf(state), ME)?.revisable).toEqual({
      editMessageId: null,
      regenerateMessageId: null,
    });
  });

  it("counts tool calls only for the one run that answered", async () => {
    const state = chat();
    state.runs = [];
    const db = fakeDb(state);
    await loadRevisionTurn(db as never, thread);
    expect(db.event.count).not.toHaveBeenCalled();
    expect(db.externalEffect.count).not.toHaveBeenCalled();
  });
});

describe("reviseInTransaction", () => {
  const revise = (
    db: FakeDb,
    messageId: string,
    revision: Parameters<typeof reviseInTransaction>[1]["revision"],
  ) =>
    reviseInTransaction(db as never, {
      actor,
      threadId: "thread-1",
      botId: "bot-1",
      messageId,
      revision,
    });

  it("regenerates: the old reply goes, its seq is reused, and a new run answers the same message", async () => {
    const db = fakeDb(chat());
    expect(await revise(db, "m-reply", { kind: "regenerate" })).toEqual({
      runId: "r-new",
      seq: 41,
    });
    expect(db.message.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["m-reply"] } } });
    expect(db.thread.update).toHaveBeenLastCalledWith({
      where: { id: "thread-1" },
      data: { nextMessageSeq: 5 },
    });
    expect(db.threadRead.updateMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1", lastReadSeq: { gt: 4 } },
      data: { lastReadSeq: 4 },
    });
    expect(db.event.deleteMany).toHaveBeenCalledWith({
      where: {
        threadId: "thread-1",
        type: { in: ["thread.message.created", "thread.message.updated"] },
        OR: [{ payload: { path: ["messageId"], equals: "m-reply" } }],
      },
    });
    expect(mocks.appendEventInTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.appendEventInTransaction).toHaveBeenCalledWith(db, {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      type: "thread.message.updated",
      payload: { messageId: "m-reply", removed: true },
    });
    expect(db.message.update).not.toHaveBeenCalled();
    expect(db.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ prompt: "Plan dinner", userId: ME, status: "queued" }),
    });
    expect(db.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: "task-new",
        trigger: "user",
        status: "queued",
        sourceMessageId: "m-ask",
      }),
    });
    expect(db.message.updateMany).toHaveBeenCalledWith({
      where: { id: "m-ask", runId: "r-1" },
      data: { runId: "r-new" },
    });
  });

  it("edits: the message takes the new text, every client is told, and the run starts on it", async () => {
    const db = fakeDb(chat());
    expect(await revise(db, "m-ask", { kind: "edit", text: "Plan lunch" })).toEqual({
      runId: "r-new",
      seq: 42,
    });
    const blocks = [{ kind: "text", text: "Plan lunch" }];
    expect(db.message.update).toHaveBeenCalledWith({ where: { id: "m-ask" }, data: { blocks } });
    expect(db.event.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: [
          { payload: { path: ["messageId"], equals: "m-ask" } },
          { payload: { path: ["messageId"], equals: "m-reply" } },
        ],
      }),
    });
    expect(mocks.appendEventInTransaction).toHaveBeenLastCalledWith(
      db,
      expect.objectContaining({
        payload: { messageId: "m-ask", role: "user", seq: 4, blocks, author: { name: "Me" } },
      }),
    );
    expect(db.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ prompt: "prompt: Plan lunch" }),
    });
  });

  it("edits a message whose run ended without a reply", async () => {
    const state = chat();
    state.messages.pop();
    state.runs[0]!.status = "cancelled";
    const db = fakeDb(state);
    await revise(db, "m-ask", { kind: "edit", text: "Again" });
    expect(db.message.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [] } } });
    expect(mocks.appendEventInTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a message the server did not name", "m-reply", { kind: "edit", text: "x" }],
    ["a reply that is not the last", "m-old", { kind: "regenerate" }],
  ] as const)("refuses %s and changes nothing", async (_, messageId, revision) => {
    const db = fakeDb(chat());
    await expect(revise(db, messageId, revision)).rejects.toBeInstanceOf(MessageNotRevisableError);
    expect(db.message.deleteMany).not.toHaveBeenCalled();
    expect(db.run.create).not.toHaveBeenCalled();
  });

  it("refuses in a Space that is being deleted", async () => {
    mocks.spaceTakesWork.mockResolvedValue(false);
    const db = fakeDb(chat());
    const error = await revise(db, "m-reply", { kind: "regenerate" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({ kind: "CONFLICT", code: "MESSAGE_NOT_REVISABLE" });
    expect(db.thread.update).not.toHaveBeenCalled();
  });
});

describe("dozoMessagesRoutes", () => {
  type Handler = (args: { context: { actor: Actor }; input: Record<string, unknown> }) => unknown;
  function setup(state: Chat, threadRow: { botId: string | null } | null = { botId: "bot-1" }) {
    const db = fakeDb(state);
    const deps = {
      prisma: {
        ...db,
        thread: {
          ...db.thread,
          findFirst: vi.fn(async () => threadRow && { ...thread, ...threadRow }),
        },
        $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
      },
      events: { notify: vi.fn(async () => undefined), publishSpaceChange: vi.fn() },
      jobs: { enqueue: vi.fn() },
    };
    const authed = {
      dozoMessages: Object.fromEntries(
        ["revisable", "edit", "regenerate"].map((name) => [
          name,
          { handler: (handler: Handler) => handler },
        ]),
      ),
    };
    const routes = dozoMessagesRoutes({ deps, authed } as unknown as RouterContext)
      .dozoMessages as unknown as Record<string, Handler>;
    const call = (name: string, input: Record<string, unknown>) =>
      routes[name]!({ context: { actor }, input });
    return { call, deps, db };
  }

  beforeEach(() => {
    mocks.resolveThreadTarget.mockResolvedValue({ kind: "bot", threadId: "thread-1" });
    mocks.modelSetup.mockResolvedValue({ needsModel: false });
  });

  it("names the revisable messages of the caller's chat", async () => {
    const { call } = setup(chat());
    expect(await call("revisable", { threadId: "thread-1" })).toEqual({
      editMessageId: "m-ask",
      regenerateMessageId: "m-reply",
    });
    expect(mocks.resolveThreadTarget).toHaveBeenCalledWith(expect.anything(), actor, {
      botId: "bot-1",
    });
  });

  it("names nothing when the turn cannot change", async () => {
    const state = chat();
    state.active = 1;
    expect(await setup(state).call("revisable", { threadId: "thread-1" })).toEqual({
      editMessageId: null,
      regenerateMessageId: null,
    });
  });

  it.each([
    ["a group or helper chat", { botId: null }],
    ["a chat outside the Space", null],
  ])("hides %s", async (_, row) => {
    await expect(
      setup(chat(), row).call("revisable", { threadId: "thread-1" }),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("hides a thread that is not the bot's own chat", async () => {
    mocks.resolveThreadTarget.mockResolvedValue({ kind: "bot", threadId: "another" });
    await expect(setup(chat()).call("revisable", { threadId: "thread-1" })).rejects.toBeInstanceOf(
      IsolationError,
    );
  });

  it("regenerates, signals the chat, and wakes the new run", async () => {
    const { call, deps } = setup(chat());
    expect(await call("regenerate", { threadId: "thread-1", messageId: "m-reply" })).toEqual({
      runId: "r-new",
    });
    expect(mocks.assertTeachingSendAllowed).toHaveBeenCalledWith(deps.prisma, "space-1", "bot-1");
    expect(deps.events.notify).toHaveBeenCalledWith("thread-1", 41);
    expect(deps.events.publishSpaceChange).toHaveBeenCalledWith("space-1", "runs");
    expect(mocks.wakeRun).toHaveBeenCalledWith(deps.jobs, "r-new");
  });

  it("edits through the same path", async () => {
    const { call, db } = setup(chat());
    await call("edit", { threadId: "thread-1", messageId: "m-ask", text: "Plan lunch" });
    expect(db.message.update).toHaveBeenCalled();
  });

  it("refuses without a model to answer, as a send does", async () => {
    mocks.modelSetup.mockResolvedValue({ needsModel: true });
    mocks.botsRunOwnModels.mockResolvedValue(false);
    const { call, deps } = setup(chat());
    await expect(
      call("regenerate", { threadId: "thread-1", messageId: "m-reply" }),
    ).rejects.toThrow(MODEL_REQUIRED_SEND_ERROR);
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("goes ahead when the bot has a model of its own", async () => {
    mocks.modelSetup.mockResolvedValue({ needsModel: true });
    mocks.botsRunOwnModels.mockResolvedValue(true);
    const { call } = setup(chat());
    await expect(
      call("regenerate", { threadId: "thread-1", messageId: "m-reply" }),
    ).resolves.toEqual({ runId: "r-new" });
  });
});
