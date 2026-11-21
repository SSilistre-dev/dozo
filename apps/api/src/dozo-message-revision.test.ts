import type { Actor } from "@rakazo/contracts";
import { ProductEventType } from "@rakazo/contracts";
import { ClientError, MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dozoMessagesRoutes,
  loadRevisionHistory,
  MessageNotRevisableError,
  planRevision,
  QUIET_EVENT_TYPES,
  REVISION_TURNS,
  revisableOf,
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
  runAsSystemInTransaction: (_tx: unknown, _reason: string, read: () => unknown) => read(),
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
    /** Newest first within each message, as the runs are read. */
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
    /** Events of the runs, by type. */
    events: [] as Array<{ runId: string; type: string }>,
    /** Runs with a recorded external effect. */
    effects: [] as string[],
    /** Every member's pins in the chat. */
    pins: [] as Array<{ messageId: string; userId: string }>,
    /** The Space's memory learns from each finished turn. */
    learns: false,
    retryAfter: null as number | null,
  };
}
type Chat = ReturnType<typeof chat>;

/** The same chat with a second turn after the first: "Make it vegan", answered by r-2. */
function twoTurns() {
  const state = chat();
  state.messages.push(
    {
      id: "m-ask-2",
      seq: 6,
      role: "user",
      runId: "r-2",
      authorUserId: ME,
      clientNonce: "nonce-2",
      blocks: [{ kind: "text", text: "Make it vegan" }],
    },
    {
      id: "m-reply-2",
      seq: 7,
      role: "bot",
      runId: "r-2",
      authorUserId: null,
      clientNonce: null,
      blocks: [{ kind: "text", text: "Lentil pasta." }],
    },
  );
  state.runs.unshift({ ...state.runs[0]!, id: "r-2", sourceMessageId: "m-ask-2" });
  return state;
}

const byMessage = (state: Chat, id: string) => state.messages.find((m) => m.id === id)!;
const byRun = (state: Chat, id: string) => state.runs.find((r) => r.id === id)!;

type MessageWhere = { role?: string | { not: string }; seq?: { gt: number } };
function fakeDb(state: Chat) {
  return {
    thread: {
      update: vi.fn(async () => ({
        id: "thread-1",
        historyCompactedUpToSeq: state.compacted,
        historyCompactionRetryAfterSeq: state.retryAfter,
        nextMessageSeq: Math.max(...state.messages.map((m) => m.seq)) + 1,
      })),
    },
    threadRead: { updateMany: vi.fn(async () => ({ count: 1 })) },
    message: {
      findMany: vi.fn(async ({ where, take }: { where: MessageWhere; take?: number }) => {
        if (typeof where.role === "string")
          return state.messages
            .filter((m) => m.role === where.role)
            .sort((a, b) => b.seq - a.seq)
            .slice(0, take)
            .map(({ id, seq, authorUserId, clientNonce, blocks }) => ({
              id,
              seq,
              authorUserId,
              clientNonce,
              blocks,
            }));
        return state.messages
          .filter((m) => m.seq > where.seq!.gt && m.role !== "user")
          .sort((a, b) => a.seq - b.seq)
          .map(({ id, seq, role, runId, blocks }) => ({ id, seq, role, runId, blocks }));
      }),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    run: {
      findMany: vi.fn(async ({ where }: { where: { sourceMessageId: { in: string[] } } }) =>
        state.runs
          .filter((run) => where.sourceMessageId.in.includes(run.sourceMessageId))
          .map(({ prompt, ...run }) => ({ ...run, task: { prompt } })),
      ),
      count: vi.fn(async () => state.active),
      create: vi.fn(async () => ({ id: "r-new" })),
    },
    task: { create: vi.fn(async () => ({ id: "task-new" })) },
    event: {
      findMany: vi.fn(
        async ({ where }: { where: { runId: { in: string[] }; type: { notIn: string[] } } }) =>
          state.events
            .filter((e) => where.runId.in.includes(e.runId) && !where.type.notIn.includes(e.type))
            .map(({ runId }) => ({ runId })),
      ),
      deleteMany: vi.fn(async () => ({ count: 2 })),
    },
    externalEffect: {
      findMany: vi.fn(async ({ where }: { where: { runId: { in: string[] } } }) =>
        state.effects.filter((runId) => where.runId.in.includes(runId)).map((runId) => ({ runId })),
      ),
    },
    // The one raw read: every member's pins on the given messages.
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, _threadId: string, ids: string[]) =>
      state.pins.filter((pin) => ids.includes(pin.messageId)),
    ),
  };
}
type FakeDb = ReturnType<typeof fakeDb>;

const thread = { id: "thread-1", historyCompactedUpToSeq: null };
const historyOf = async (state: Chat) => ({
  ...(await loadRevisionHistory(fakeDb(state) as never, thread, {
    userId: ME,
    learnsTurns: state.learns,
  })),
  compactedUpToSeq: state.compacted,
});
const revisable = async (state: Chat) => revisableOf(planRevision(await historyOf(state), ME));
const NOTHING = { editMessageId: null, regenerateMessageId: null };

beforeEach(() => {
  vi.clearAllMocks();
  let seq = 40;
  mocks.appendEventInTransaction.mockImplementation(async () => ({ seq: ++seq }));
  mocks.spaceTakesWork.mockResolvedValue(true);
  mocks.loadMessageAuthor.mockResolvedValue({ name: "Me" });
});

describe("planRevision", () => {
  it("offers Edit on the last message and Regenerate on the last reply of a quiet turn", async () => {
    expect(await revisable(chat())).toEqual({
      editMessageId: "m-ask",
      regenerateMessageId: "m-reply",
    });
  });

  it("offers nothing in an empty chat", async () => {
    const state = chat();
    state.messages = [];
    expect((await historyOf(state)).turns).toEqual([]);
    expect(planRevision(null, ME)).toEqual([]);
  });

  const refusals: Array<[string, (state: Chat) => void]> = [
    ["while a run works or waits", (s) => (s.active = 1)],
    [
      "after a tool call, which may have acted outside the chat",
      (s) => s.events.push({ runId: "r-1", type: "agent.tool.called" }),
    ],
    ["after a recorded external effect", (s) => s.effects.push("r-1")],
    ["after a memory write", (s) => s.events.push({ runId: "r-1", type: "memory.revised" })],
    ["after a routine was set up", (s) => s.events.push({ runId: "r-1", type: "routine.created" })],
    ["for another person's message", (s) => (byMessage(s, "m-ask").authorUserId = "someone")],
    ["for a run another person started", (s) => (byRun(s, "r-1").userId = "someone")],
    ["for a chat-app message", (s) => (byRun(s, "r-1").trigger = "messaging")],
    [
      "once the reply was mirrored to a chat app",
      (s) => (byRun(s, "r-1").messagingMirroredAt = new Date()),
    ],
    ["before the run ends", (s) => (byRun(s, "r-1").status = "running")],
    ["when the message went to a run that was already working", (s) => (s.runs = [])],
    [
      "when an earlier run of the message was someone else's",
      (s) => s.runs.push({ ...byRun(s, "r-1"), id: "r-0", userId: "someone" }),
    ],
    [
      "when the reply came from an earlier run, not the newest",
      (s) => s.runs.unshift({ ...byRun(s, "r-1"), id: "r-3", status: "failed" }),
    ],
    [
      "for a group channel message",
      (s) => (byMessage(s, "m-ask").blocks = [{ kind: "channel_message", channelId: "c" }]),
    ],
    ["for a turn of a call", (s) => (byMessage(s, "m-ask").clientNonce = "call:abc:turn")],
    ["when the stored blocks lost entries", (s) => (byMessage(s, "m-ask").blocks = ["broken"])],
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
    expect(planRevision(await historyOf(state), ME)).toEqual([]);
  });

  it("edits only a text message and regenerates only an existing reply", async () => {
    const state = chat();
    byMessage(state, "m-ask").blocks = [
      { kind: "text", text: "Look" },
      { kind: "image", artifactId: "a" },
    ];
    state.messages.pop();
    byRun(state, "r-1").status = "failed";
    expect(await revisable(state)).toEqual(NOTHING);
  });

  it("offers both again after a revision, judged on the newest run", async () => {
    const state = chat();
    // A regenerate left the first run and started the one that wrote the reply.
    state.runs.push({ ...byRun(state, "r-1"), id: "r-0" });
    expect(await revisable(state)).toEqual({
      editMessageId: "m-ask",
      regenerateMessageId: "m-reply",
    });
  });

  it("asks about the tool calls, effects and records of every run the turns started", async () => {
    const state = twoTurns();
    state.runs.push({ ...byRun(state, "r-1"), id: "r-0" });
    const db = fakeDb(state);
    await loadRevisionHistory(db as never, thread, { userId: ME, learnsTurns: false });
    const runId = { in: ["r-2", "r-1", "r-0"] };
    expect(db.event.findMany).toHaveBeenCalledWith({
      where: {
        runId,
        type: { notIn: QUIET_EVENT_TYPES },
      },
      select: { runId: true },
      distinct: ["runId"],
    });
    expect(db.externalEffect.findMany).toHaveBeenCalledWith({
      where: { runId },
      select: { runId: true },
      distinct: ["runId"],
    });
    expect(db.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "thread-1", role: "user" },
        take: REVISION_TURNS,
      }),
    );
  });

  it("offers an earlier message and reply when every later turn is quiet", async () => {
    expect(await revisable(twoTurns())).toEqual({
      editMessageId: "m-ask-2",
      regenerateMessageId: "m-reply-2",
      earlierEditMessageIds: ["m-ask"],
      earlierRegenerateMessageIds: ["m-reply"],
      // Its reply and the later turn's two messages.
      removedCounts: { "m-ask": 3, "m-reply": 3 },
    });
  });

  // Each of these in the later turn keeps the earlier one as it is: going back would remove it.
  const laterRefusals: Array<[string, (state: Chat) => void]> = [
    [
      "a tool call (a file, a page, an email)",
      (s) => s.events.push({ runId: "r-2", type: "agent.tool.called" }),
    ],
    ["a memory write", (s) => s.events.push({ runId: "r-2", type: "memory.revised" })],
    ["a routine or reminder", (s) => s.events.push({ runId: "r-2", type: "routine.created" })],
    ["an external effect", (s) => s.effects.push("r-2")],
    ["another person's message", (s) => (byMessage(s, "m-ask-2").authorUserId = "someone")],
    [
      "a chat-app message",
      (s) => (byMessage(s, "m-ask-2").blocks = [{ kind: "channel_message", channelId: "c" }]),
    ],
    ["a call", (s) => (byMessage(s, "m-ask-2").clientNonce = "call:abc:turn")],
    ["a run another person started", (s) => (byRun(s, "r-2").userId = "someone")],
    ["a reply mirrored to a chat app", (s) => (byRun(s, "r-2").messagingMirroredAt = new Date())],
    [
      "a bot message no turn of theirs asked for (a reminder firing)",
      (s) =>
        s.messages.push({
          id: "m-reminder",
          seq: 8,
          role: "bot",
          runId: "r-routine",
          authorUserId: null,
          clientNonce: null,
          blocks: [{ kind: "text", text: "Time to cook." }],
        }),
    ],
  ];
  it.each(laterRefusals)("offers no earlier turn after %s", async (_, change) => {
    const state = twoTurns();
    change(state);
    const result = await revisable(state);
    expect(result.earlierEditMessageIds).toBeUndefined();
    expect(result.earlierRegenerateMessageIds).toBeUndefined();
  });

  it("offers the newer turn but not one in the compaction summary", async () => {
    const state = twoTurns();
    state.compacted = 5;
    expect(await revisable(state)).toEqual({
      editMessageId: "m-ask-2",
      regenerateMessageId: "m-reply-2",
    });
  });

  it("goes back past a reaction that started nothing, which offers nothing itself", async () => {
    const state = chat();
    state.messages.push({
      id: "m-thumbs",
      seq: 6,
      role: "user",
      runId: null,
      authorUserId: ME,
      clientNonce: "nonce-thumbs",
      blocks: [{ kind: "text", text: "👍" }],
    });
    expect(await revisable(state)).toEqual({
      editMessageId: null,
      regenerateMessageId: null,
      earlierEditMessageIds: ["m-ask"],
      earlierRegenerateMessageIds: ["m-reply"],
      removedCounts: { "m-ask": 2, "m-reply": 2 },
    });
  });

  it("offers nothing at all when the Space's memory learns from each turn", async () => {
    const state = twoTurns();
    state.learns = true;
    expect(await revisable(state)).toEqual(NOTHING);
  });

  it("goes back past the caller's own pins, but not past another member's", async () => {
    const state = twoTurns();
    state.pins = [
      { messageId: "m-reply-2", userId: ME },
      { messageId: "m-ask", userId: "someone" },
    ];
    // The other pin is on the earlier message itself, which stays when it changes.
    expect((await revisable(state)).earlierEditMessageIds).toEqual(["m-ask"]);
    state.pins.push({ messageId: "m-ask-2", userId: "someone" });
    expect((await revisable(state)).earlierEditMessageIds).toBeUndefined();
    // On a reply that would go, it stops the turn itself.
    state.pins = [{ messageId: "m-reply-2", userId: "someone" }];
    expect(await revisable(state)).toEqual(NOTHING);
  });

  it("does not go back past a later message with a file", async () => {
    const state = twoTurns();
    byMessage(state, "m-ask-2").blocks = [
      { kind: "text", text: "Here" },
      { kind: "image", artifactId: "a" },
    ];
    // Regenerating keeps the message and its file; going further back would remove them.
    expect(await revisable(state)).toEqual({
      editMessageId: null,
      regenerateMessageId: "m-reply-2",
    });
  });

  it.each(["file", "chart", "page", "card"])(
    "offers nothing over a reply that carries a %s, which may live on outside the words",
    async (kind) => {
      const state = chat();
      byMessage(state, "m-reply").blocks = [{ kind: "text", text: "Done" }, { kind }];
      expect(await revisable(state)).toEqual(NOTHING);
    },
  );

  it("treats an event type it does not know as acting outside the chat", async () => {
    const state = twoTurns();
    state.events.push({ runId: "r-2", type: "someday.new" });
    expect(await revisable(state)).toEqual(NOTHING);
  });
});

/**
 * Every known event type is classified: what a run that only talked records, or what may have
 * acted outside the chat. A new type fails here until someone decides; until then it counts as
 * acting.
 */
describe("event types", () => {
  const ACTING = [
    "thread.cleared",
    "thread.message.reaction",
    "thread.artifact",
    "thread.ask",
    "thread.choice",
    "thread.computer",
    "thread.subagent",
    "thread.cloud_agent",
    "thread.call.ended",
    "run.waiting_input",
    "computer.takeover.requested",
    "computer.takeover.granted",
    "computer.takeover.released",
    "computer.command",
    "memory.revised",
    "routine.created",
    "routine.updated",
    "routine.fired",
    "skill.teaching.started",
    "skill.teaching.stopped",
    "skill.draft.created",
    "skill.saved",
    "effect.recorded",
    "agent.tool.called",
    "agent.tool.completed",
    "effect.reconciled",
    "bot.spawned",
    "bot.updated",
    "bot.archived",
    "bot.deleted",
    "group.created",
    "group.updated",
    "group.handoff",
  ];

  it("puts each one on one side", () => {
    expect(QUIET_EVENT_TYPES.filter((type) => ACTING.includes(type))).toEqual([]);
    expect([...QUIET_EVENT_TYPES, ...ACTING].sort()).toEqual([...ProductEventType.options].sort());
  });

  it.each(ACTING)("does not undo a turn whose run recorded %s", async (type) => {
    const state = twoTurns();
    state.events.push({ runId: "r-2", type });
    expect(await revisable(state)).toEqual(NOTHING);
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
      learnsTurns: false,
    });

  it("regenerates: the old reply goes, its seq is reused, and a new run answers the same message", async () => {
    const db = fakeDb(chat());
    expect(await revise(db, "m-reply", { kind: "regenerate" })).toEqual({
      runId: "r-new",
      seq: 41,
      pinnedBy: [],
    });
    expect(db.message.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["m-reply"] } } });
    expect(db.thread.update).toHaveBeenLastCalledWith({
      where: { id: "thread-1" },
      data: {
        nextMessageSeq: 5,
        dozoRewinds: { increment: 1 },
        historyCompactionRetryAfterSeq: null,
      },
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
    expect(await revise(db, "m-ask", { kind: "edit", text: "Plan lunch" })).toMatchObject({
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
    byRun(state, "r-1").status = "cancelled";
    const db = fakeDb(state);
    // Nothing went, so no one's pins are read again.
    expect(await revise(db, "m-ask", { kind: "edit", text: "Again" })).toMatchObject({
      pinnedBy: [],
    });
    expect(db.message.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [] } } });
    expect(mocks.appendEventInTransaction).toHaveBeenCalledTimes(1);
  });

  it("edits an earlier message: every later message goes, oldest first, and the run starts there", async () => {
    const state = twoTurns();
    // The caller's own pin on a message that goes, and a summary that was too long.
    state.pins = [{ messageId: "m-reply-2", userId: ME }];
    state.retryAfter = 60;
    const db = fakeDb(state);
    expect(await revise(db, "m-ask", { kind: "edit", text: "Plan lunch" })).toEqual({
      runId: "r-new",
      seq: 44,
      pinnedBy: [ME],
    });
    const removed = ["m-reply", "m-ask-2", "m-reply-2"];
    expect(db.message.deleteMany).toHaveBeenCalledWith({ where: { id: { in: removed } } });
    // Three messages went: the summary still waits for as many new ones as before.
    expect(db.thread.update).toHaveBeenLastCalledWith({
      where: { id: "thread-1" },
      data: {
        nextMessageSeq: 5,
        dozoRewinds: { increment: 1 },
        historyCompactionRetryAfterSeq: 57,
      },
    });
    expect(db.threadRead.updateMany).toHaveBeenCalledWith({
      where: { threadId: "thread-1", lastReadSeq: { gt: 4 } },
      data: { lastReadSeq: 4 },
    });
    expect(db.event.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: ["m-ask", ...removed].map((id) => ({ payload: { path: ["messageId"], equals: id } })),
      }),
    });
    expect(mocks.appendEventInTransaction.mock.calls.map(([, event]) => event.payload)).toEqual([
      ...removed.map((messageId) => ({ messageId, removed: true })),
      expect.objectContaining({
        messageId: "m-ask",
        blocks: [{ kind: "text", text: "Plan lunch" }],
      }),
    ]);
    expect(db.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sourceMessageId: "m-ask" }),
    });
    expect(db.message.updateMany).toHaveBeenCalledWith({
      where: { id: "m-ask", runId: "r-1" },
      data: { runId: "r-new" },
    });
  });

  it("regenerates an earlier reply from the prompt of the message it answered", async () => {
    const db = fakeDb(twoTurns());
    await revise(db, "m-reply", { kind: "regenerate" });
    expect(db.message.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["m-reply", "m-ask-2", "m-reply-2"] } },
    });
    expect(db.message.update).not.toHaveBeenCalled();
    expect(db.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ prompt: "Plan dinner" }),
    });
  });

  it.each([
    ["a message the server did not name", "m-reply", { kind: "edit", text: "x" }],
    ["a reply that ends no turn of theirs", "m-old", { kind: "regenerate" }],
  ] as const)("refuses %s and changes nothing", async (_, messageId, revision) => {
    const db = fakeDb(chat());
    await expect(revise(db, messageId, revision)).rejects.toBeInstanceOf(MessageNotRevisableError);
    expect(db.message.deleteMany).not.toHaveBeenCalled();
    expect(db.run.create).not.toHaveBeenCalled();
  });

  it.each([
    ["a memory write", { runId: "r-2", type: "memory.revised" }],
    ["a routine", { runId: "r-2", type: "routine.created" }],
    ["a file the bot wrote", { runId: "r-2", type: "agent.tool.called" }],
  ])("refuses to go back over %s and changes nothing", async (_, event) => {
    const state = twoTurns();
    state.events.push(event);
    const db = fakeDb(state);
    await expect(revise(db, "m-ask", { kind: "edit", text: "x" })).rejects.toBeInstanceOf(
      MessageNotRevisableError,
    );
    await expect(revise(db, "m-reply", { kind: "regenerate" })).rejects.toBeInstanceOf(
      MessageNotRevisableError,
    );
    expect(db.message.deleteMany).not.toHaveBeenCalled();
    expect(db.run.create).not.toHaveBeenCalled();
  });

  it("decides again under the lock: a message sent after the menu read stops the change", async () => {
    const state = twoTurns();
    expect((await revisable(state)).earlierEditMessageIds).toEqual(["m-ask"]);
    // The person's other device sent a message; its run is still working.
    state.messages.push({
      id: "m-ask-3",
      seq: 8,
      role: "user",
      runId: "r-3",
      authorUserId: ME,
      clientNonce: "nonce-3",
      blocks: [{ kind: "text", text: "And dessert" }],
    });
    state.runs.unshift({
      ...byRun(state, "r-2"),
      id: "r-3",
      sourceMessageId: "m-ask-3",
      status: "running",
    });
    state.active = 1;
    const db = fakeDb(state);
    await expect(revise(db, "m-ask", { kind: "edit", text: "x" })).rejects.toBeInstanceOf(
      MessageNotRevisableError,
    );
    expect(db.message.deleteMany).not.toHaveBeenCalled();
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
  function setup(
    state: Chat,
    threadRow: { botId: string | null } | null = { botId: "bot-1" },
    extraChatOf: string | null = null,
  ) {
    const db = fakeDb(state);
    const deps = {
      prisma: {
        ...db,
        thread: {
          ...db.thread,
          findFirst: vi.fn(async () => threadRow && { ...thread, ...threadRow }),
        },
        // A bot's extra chat's row, when the thread is one.
        $queryRaw: vi.fn(async () => (extraChatOf ? [{ botId: extraChatOf }] : [])),
        $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
      },
      events: { notify: vi.fn(async () => undefined), publishSpaceChange: vi.fn() },
      jobs: { enqueue: vi.fn() },
      memoryProviders: {
        resolve: vi.fn(async () =>
          state.learns ? { provider: { retainConversation: vi.fn() } } : null,
        ),
      },
    };
    const authed = {
      dozoMessages: Object.fromEntries(
        ["revisable", "edit", "regenerate", "pins", "pin"].map((name) => [
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
      chatBotId: "bot-1",
      chatId: "thread-1",
    });
  });

  it("names them in a bot's extra chat too, through that chat of its bot", async () => {
    const { call } = setup(chat(), { botId: null }, "bot-1");
    expect(await call("revisable", { threadId: "thread-1" })).toEqual({
      editMessageId: "m-ask",
      regenerateMessageId: "m-reply",
    });
    expect(mocks.resolveThreadTarget).toHaveBeenCalledWith(expect.anything(), actor, {
      chatBotId: "bot-1",
      chatId: "thread-1",
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

  it("reports a committed change as done when its signal fails", async () => {
    const { call, deps } = setup(chat());
    deps.events.notify.mockRejectedValue(new Error("realtime down"));
    await expect(
      call("regenerate", { threadId: "thread-1", messageId: "m-reply" }),
    ).resolves.toEqual({ runId: "r-new" });
    expect(mocks.wakeRun).toHaveBeenCalledWith(deps.jobs, "r-new");
  });

  it("tells the caller to read their pins again when one went", async () => {
    const state = twoTurns();
    state.pins = [{ messageId: "m-ask-2", userId: ME }];
    const { call, deps } = setup(state);
    const publishRosterChange = vi.fn(async () => undefined);
    Object.assign(deps.events, { publishRosterChange });
    await call("edit", { threadId: "thread-1", messageId: "m-ask", text: "Plan lunch" });
    expect(publishRosterChange).toHaveBeenCalledWith({ userIds: [ME] });
  });

  it("names earlier messages too, and still nothing for another person's chat turn", async () => {
    const state = twoTurns();
    byMessage(state, "m-ask-2").authorUserId = "someone";
    expect(await setup(state).call("revisable", { threadId: "thread-1" })).toEqual(NOTHING);
    expect(await setup(twoTurns()).call("revisable", { threadId: "thread-1" })).toMatchObject({
      earlierEditMessageIds: ["m-ask"],
    });
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
