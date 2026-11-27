import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STOPPED_BY_MESSAGE_NOTE, stoppedRoutineNote } from "../threads/thread-stop.js";
import type { RouterContext } from "./context.js";
import { dozoQueueRoutes, loadDozoQueue } from "./dozo-queue.js";

const mocks = vi.hoisted(() => ({
  wakeRun: vi.fn(),
  resolveThreadTarget: vi.fn(),
  finishThreadStop: vi.fn(),
  appendEventInTransaction: vi.fn(),
  clearEndedRunState: vi.fn(),
  createPendingSteeringRun: vi.fn(),
  createThreadMessage: vi.fn(),
}));

vi.mock("@rakazo/adapters", () => ({ wakeRun: mocks.wakeRun }));
vi.mock("../threads/thread-target.js", () => ({ resolveThreadTarget: mocks.resolveThreadTarget }));
vi.mock("../threads/thread-stop.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threads/thread-stop.js")>()),
  finishThreadStop: mocks.finishThreadStop,
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  appendEventInTransaction: mocks.appendEventInTransaction,
  clearEndedRunState: mocks.clearEndedRunState,
  createPendingSteeringRun: mocks.createPendingSteeringRun,
  createThreadMessageInTransaction: mocks.createThreadMessage,
}));

const ME = "user-me";
const actor: Actor = { userId: ME, spaceId: "space-1", email: "me@example.test" } as Actor;
const NOW = new Date("2026-11-21T12:00:00Z");

const runRow = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  botId: "bot-1",
  userId: ME,
  status: "queued",
  trigger: "user",
  wakeAt: null,
  createdAt: new Date(NOW.getTime() - 10_000),
  threadId: "thread-1",
  sourceMessageId: null,
  routine: null,
  startedAt: null,
  retryOfRunId: null,
  _count: { attempts: 0 },
  ...patch,
});

type Rows = Record<string, unknown>[];
function fakePrisma(
  state: {
    runs?: Rows;
    holding?: Rows;
    steering?: Rows;
    leases?: Rows;
    leaseRuns?: Rows;
    messages?: Rows;
    bots?: Rows;
  } = {},
) {
  const runFindMany = vi.fn(
    async ({ where }: { where: { id?: unknown; status?: { in: string[] } } }) => {
      if (where.id) return state.leaseRuns ?? [];
      return where.status?.in.includes("queued") && where.status.in.length === 3
        ? (state.runs ?? [])
        : (state.holding ?? []);
    },
  );
  return {
    bot: {
      findMany: vi.fn(async () => state.bots ?? [{ id: "bot-1", computerId: "computer-1" }]),
    },
    run: { findMany: runFindMany },
    steeringMessage: { findMany: vi.fn(async () => state.steering ?? []) },
    computerExecutionLease: { findMany: vi.fn(async () => state.leases ?? []) },
    message: { findMany: vi.fn(async () => state.messages ?? []) },
  };
}

describe("reading what waits", () => {
  const load = (prisma: ReturnType<typeof fakePrisma>) =>
    loadDozoQueue(prisma as never, actor, { threadId: "thread-1", botIds: ["bot-1"] }, NOW);

  it("asks only for the caller's Space and this conversation's held messages", async () => {
    const prisma = fakePrisma();
    await load(prisma);
    expect(prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["bot-1"] }, spaceId: "space-1" } }),
    );
    for (const [args] of prisma.run.findMany.mock.calls)
      expect(args.where).toMatchObject({ spaceId: "space-1" });
    expect(prisma.steeringMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runId: null,
          claimedAt: null,
          message: { threadId: "thread-1" },
        }),
      }),
    );
  });

  it("lists a queued run behind the bot's working run, with the caller's own words only", async () => {
    const prisma = fakePrisma({
      runs: [
        runRow("working", { status: "running", userId: "someone" }),
        runRow("mine", { sourceMessageId: "m-1" }),
        runRow("theirs", { userId: "someone", sourceMessageId: "m-2" }),
      ],
      messages: [{ id: "m-1", blocks: [{ kind: "text", text: "  Plan\nthe trip  " }] }],
    });
    const items = await load(prisma);
    expect(items.map((item) => [item.id, item.mine, item.label])).toEqual([
      ["mine", true, "Plan the trip"],
      ["theirs", false, null],
    ]);
    // Only the caller's own message is read for words.
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["m-1"] }, threadId: "thread-1" } }),
    );
  });

  it("lists a routine waiting for the busy chat, but not a run backing off after a failed attempt", async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const prisma = fakePrisma({
      runs: [
        runRow("working", { status: "running", userId: "someone" }),
        runRow("chat-wait", { trigger: "routine", wakeAt: later }),
        runRow("failed", { trigger: "routine", wakeAt: later, _count: { attempts: 1 } }),
        runRow("retry", { trigger: "routine", wakeAt: later, retryOfRunId: "earlier" }),
      ],
    });
    expect((await load(prisma)).map((item) => item.id)).toEqual(["chat-wait"]);
  });

  it("reads no message at all when nothing of the caller's waits", async () => {
    const prisma = fakePrisma({
      runs: [
        runRow("working", { status: "running", userId: "someone" }),
        runRow("theirs", { userId: "someone", sourceMessageId: "m-2" }),
      ],
    });
    await load(prisma);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it("lists a message held behind a run, labelled for its sender", async () => {
    const blocker = runRow("blocker", { status: "running", userId: "someone" });
    const prisma = fakePrisma({
      runs: [blocker],
      holding: [blocker],
      steering: [
        { botId: "bot-1", userId: ME, message: { id: "m-mine", seq: 2, runId: "blocker" } },
        {
          botId: "bot-1",
          userId: "someone",
          message: { id: "m-theirs", seq: 3, runId: "blocker" },
        },
      ],
      messages: [
        { id: "m-mine", blocks: [{ kind: "text", text: "My question" }, { kind: "bogus" }] },
      ],
    });
    const items = await load(prisma);
    expect(items).toEqual([
      expect.objectContaining({
        id: "m-mine",
        kind: "message",
        position: 1,
        mine: true,
        label: "My question",
      }),
      expect.objectContaining({
        id: "m-theirs",
        kind: "message",
        position: 2,
        mine: false,
        label: null,
      }),
    ]);
  });

  it("gives no label for a message with no text", async () => {
    const blocker = runRow("blocker", { status: "running" });
    const prisma = fakePrisma({
      runs: [blocker],
      holding: [blocker],
      steering: [
        { botId: "bot-1", userId: ME, message: { id: "m-mine", seq: 2, runId: "blocker" } },
      ],
      messages: [{ id: "m-mine", blocks: [{ kind: "text", text: "   " }] }],
    });
    expect((await load(prisma))[0]?.label).toBeNull();
  });

  describe("a computer another bot holds", () => {
    const waiting = runRow("waiting", { wakeAt: new Date(NOW.getTime() + 30_000) });
    const lease = { computerId: "computer-1", botId: "bot-2", runId: "holder" };
    const wait = async (leaseRuns: Rows, leases: Rows = [lease]) => {
      const prisma = fakePrisma({ runs: [waiting], leases, leaseRuns });
      return { prisma, items: await load(prisma) };
    };

    it("holds a run for a live lease whose run works, and names a routine to its owner", async () => {
      const { items, prisma } = await wait([
        runRow("holder", {
          botId: "bot-2",
          status: "running",
          trigger: "routine",
          routine: { name: "Nightly" },
        }),
      ]);
      expect(items).toEqual([
        expect.objectContaining({ id: "waiting", reason: "computer_busy", waitingFor: "Nightly" }),
      ]);
      expect(prisma.computerExecutionLease.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { computerId: { in: ["computer-1"] }, expiresAt: { gt: NOW } },
        }),
      );
    });

    it("holds a run for a lease that has no run: a boot, a reset, an update", async () => {
      const { items } = await wait([]);
      expect(items[0]).toMatchObject({ reason: "computer_busy", waitingFor: null });
    });

    it.each(["completed", "failed", "cancelled", "waiting_takeover"])(
      "does not hold a run for a lease whose run is %s",
      async (status) => {
        const { items } = await wait([runRow("holder", { botId: "bot-2", status })]);
        expect(items).toEqual([]);
      },
    );

    it("reads no lease for a bot with no computer", async () => {
      const prisma = fakePrisma({ runs: [waiting], bots: [{ id: "bot-1", computerId: null }] });
      expect(await load(prisma)).toEqual([]);
      expect(prisma.computerExecutionLease.findMany).not.toHaveBeenCalled();
    });
  });
});

describe("dozoQueueRoutes", () => {
  type Handler = (args: {
    context: { actor: Actor };
    input: Record<string, unknown>;
  }) => Promise<unknown>;

  function setup(
    patch: {
      run?: {
        threadId: string;
        botId: string;
        trigger?: string;
        routine?: { name: string } | null;
      } | null;
      cancelled?: number;
      message?: { threadId: string } | null;
      removed?: number;
      prisma?: ReturnType<typeof fakePrisma>;
    } = {},
  ) {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        updateManyAndReturn: vi.fn(async () => Array(patch.cancelled ?? 1).fill({ id: "run-1" })),
      },
      steeringMessage: {
        findMany: vi.fn(async () =>
          (patch.removed ?? 1) > 0 ? [{ id: "steer-1", botId: "bot-1" }] : [],
        ),
        deleteMany: vi.fn(async () => ({ count: patch.removed ?? 1 })),
      },
      event: { deleteMany: vi.fn() },
    };
    const prisma = {
      ...(patch.prisma ?? fakePrisma()),
      run: {
        ...(patch.prisma ?? fakePrisma()).run,
        findFirst: vi.fn(async () =>
          patch.run === undefined
            ? { threadId: "thread-1", botId: "bot-1", trigger: "user", routine: null }
            : patch.run,
        ),
      },
      message: {
        findFirst: vi.fn(async () =>
          patch.message === undefined ? { threadId: "thread-1" } : patch.message,
        ),
      },
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const deps = {
      prisma,
      events: { publishSpaceChange: vi.fn(), notify: vi.fn() },
      jobs: { enqueue: vi.fn() },
      sandbox: {},
    };
    const authed = {
      dozoQueue: Object.fromEntries(
        ["list", "cancelWaiting"].map((name) => [name, { handler: (handler: Handler) => handler }]),
      ),
    };
    const routes = dozoQueueRoutes({ deps, authed } as unknown as RouterContext)
      .dozoQueue as unknown as Record<string, Handler>;
    const call = (name: string, input: Record<string, unknown>) =>
      routes[name]!({ context: { actor }, input });
    return { call, deps, tx, prisma };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appendEventInTransaction.mockResolvedValue({ seq: 7 });
    mocks.createPendingSteeringRun.mockResolvedValue(null);
    mocks.createThreadMessage.mockResolvedValue({ id: "note-1" });
    mocks.resolveThreadTarget.mockResolvedValue({
      kind: "bot",
      botId: "bot-1",
      threadId: "thread-1",
    });
  });

  it("lists for the bot the caller can reach, and for each bot of a group", async () => {
    const { call, prisma } = setup();
    expect(await call("list", { botId: "bot-1" })).toEqual({ items: [] });
    expect(mocks.resolveThreadTarget).toHaveBeenCalledWith(prisma, actor, { botId: "bot-1" });
    mocks.resolveThreadTarget.mockResolvedValue({
      kind: "group",
      threadId: "thread-g",
      memberBotIds: ["bot-1", "bot-2"],
    });
    await call("list", { groupId: "group-1" });
    expect(prisma.bot.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: { in: ["bot-1", "bot-2"] }, spaceId: "space-1" } }),
    );
  });

  it("refuses a caller who cannot reach the bot, before reading anything", async () => {
    const { call, prisma } = setup();
    mocks.resolveThreadTarget.mockRejectedValue(new Error("Resource not found"));
    await expect(call("list", { botId: "bot-1" })).rejects.toThrow("Resource not found");
    expect(prisma.run.findMany).not.toHaveBeenCalled();
  });

  describe("cancelling the caller's own queued run", () => {
    it("cancels only that run, as the caller's, and signals the change", async () => {
      const { call, tx, prisma, deps } = setup();
      expect(await call("cancelWaiting", { runId: "run-1" })).toEqual({ cancelled: true });
      const own = { id: "run-1", spaceId: "space-1", userId: ME, status: "queued" };
      expect(prisma.run.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: own }));
      expect(tx.run.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: own,
          data: expect.objectContaining({ status: "cancelled" }),
        }),
      );
      expect(mocks.clearEndedRunState).toHaveBeenCalledWith(tx, ["run-1"]);
      expect(tx.steeringMessage.deleteMany).toHaveBeenCalledWith({ where: { runId: "run-1" } });
      expect(mocks.appendEventInTransaction).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ type: "run.cancelled", runId: "run-1", threadId: "thread-1" }),
      );
      expect(mocks.finishThreadStop).toHaveBeenCalledWith(
        deps,
        actor,
        expect.objectContaining({ threadId: "thread-1" }),
        { runIds: ["run-1"], computers: [], leases: [], eventSeq: 7, stoppedHelpers: [] },
      );
      expect(mocks.wakeRun).not.toHaveBeenCalled();
    });

    it("says so in the chat as Stop does, and lets the other clients know", async () => {
      mocks.appendEventInTransaction
        .mockResolvedValueOnce({ seq: 7 })
        .mockResolvedValueOnce({ seq: 8 });
      const { call, tx, deps } = setup();
      await call("cancelWaiting", { runId: "run-1" });
      const blocks = [{ kind: "meta", text: STOPPED_BY_MESSAGE_NOTE }];
      expect(mocks.createThreadMessage).toHaveBeenCalledWith(tx, {
        threadId: "thread-1",
        role: "system",
        blocks,
        botId: "bot-1",
      });
      expect(mocks.appendEventInTransaction).toHaveBeenLastCalledWith(tx, {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        type: "thread.message.created",
        payload: { messageId: "note-1", role: "system", blocks },
      });
      // The last event's seq is what subscribers are told to catch up to.
      expect(mocks.finishThreadStop).toHaveBeenCalledWith(
        deps,
        actor,
        expect.anything(),
        expect.objectContaining({ eventSeq: 8 }),
      );
    });

    it("names the routine when the queued run is a routine's", async () => {
      const { call } = setup({
        run: {
          threadId: "thread-1",
          botId: "bot-1",
          trigger: "routine",
          routine: { name: "Weekly sums" },
        },
      });
      await call("cancelWaiting", { runId: "run-1" });
      expect(mocks.createThreadMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          blocks: [{ kind: "meta", text: stoppedRoutineNote("Weekly sums") }],
        }),
      );
    });

    it("says nothing when the run had already started", async () => {
      const { call } = setup({ cancelled: 0 });
      await call("cancelWaiting", { runId: "run-1" }).catch(() => undefined);
      expect(mocks.createThreadMessage).not.toHaveBeenCalled();
    });

    it("starts a run for messages that waited behind it", async () => {
      mocks.createPendingSteeringRun.mockResolvedValue("run-next");
      const { call, deps } = setup();
      await call("cancelWaiting", { runId: "run-1" });
      expect(mocks.wakeRun).toHaveBeenCalledWith(deps.jobs, "run-next");
    });

    it("answers a run that is not the caller's, not queued, or not there as not found", async () => {
      const { call, prisma } = setup({ run: null });
      const refused = await Promise.resolve(call("cancelWaiting", { runId: "run-1" })).catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(ClientError);
      expect(refused).toMatchObject({ kind: "NOT_FOUND" });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(mocks.finishThreadStop).not.toHaveBeenCalled();
    });

    it("answers a run that started in the meantime as not found and stops nothing", async () => {
      const { call } = setup({ cancelled: 0 });
      await expect(call("cancelWaiting", { runId: "run-1" })).rejects.toMatchObject({
        kind: "NOT_FOUND",
      });
      expect(mocks.finishThreadStop).not.toHaveBeenCalled();
      expect(mocks.appendEventInTransaction).not.toHaveBeenCalled();
    });
  });

  describe("cancelling the caller's own held message", () => {
    it("removes only that person's unclaimed hold and signals the change", async () => {
      const { call, tx, deps } = setup();
      expect(await call("cancelWaiting", { messageId: "m-1" })).toEqual({ cancelled: true });
      expect(tx.steeringMessage.deleteMany).toHaveBeenCalledWith({
        where: { messageId: "m-1", userId: ME, runId: null, claimedAt: null },
      });
      expect(deps.events.publishSpaceChange).toHaveBeenCalledWith("space-1", "runs");
    });

    it("says so in the chat as Stop does, and lets the other clients know", async () => {
      mocks.appendEventInTransaction.mockResolvedValue({ seq: 9 });
      const { call, tx, deps } = setup();
      await call("cancelWaiting", { messageId: "m-1" });
      const blocks = [{ kind: "meta", text: STOPPED_BY_MESSAGE_NOTE }];
      expect(mocks.createThreadMessage).toHaveBeenCalledWith(tx, {
        threadId: "thread-1",
        role: "system",
        blocks,
        botId: "bot-1",
      });
      expect(mocks.appendEventInTransaction).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ type: "thread.message.created", threadId: "thread-1" }),
      );
      expect(mocks.finishThreadStop).toHaveBeenCalledWith(
        deps,
        actor,
        { threadId: "thread-1" },
        expect.objectContaining({ runIds: [], eventSeq: 9 }),
      );
      expect(deps.events.publishSpaceChange).toHaveBeenCalledWith("space-1", "runs");
    });

    it("says nothing when there was no hold to remove", async () => {
      const { call } = setup({ removed: 0 });
      await call("cancelWaiting", { messageId: "m-1" }).catch(() => undefined);
      expect(mocks.createThreadMessage).not.toHaveBeenCalled();
      expect(mocks.finishThreadStop).not.toHaveBeenCalled();
    });

    it("answers a message of another Space as not found", async () => {
      const { call, prisma } = setup({ message: null });
      await expect(call("cancelWaiting", { messageId: "m-1" })).rejects.toMatchObject({
        kind: "NOT_FOUND",
      });
      expect(prisma.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "m-1", thread: { spaceId: "space-1" } } }),
      );
    });

    it("answers someone else's, a claimed or a steering message as not found, with no signal", async () => {
      const { call, deps } = setup({ removed: 0 });
      await expect(call("cancelWaiting", { messageId: "m-1" })).rejects.toMatchObject({
        kind: "NOT_FOUND",
      });
      expect(deps.events.publishSpaceChange).not.toHaveBeenCalled();
    });
  });
});
