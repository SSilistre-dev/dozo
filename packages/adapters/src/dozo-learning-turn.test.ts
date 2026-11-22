import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningReviewDeps } from "./dozo-learning-review.js";
import { LEARNING_IDLE_MS, LEARNING_REVIEW_BACKUP_MS } from "./dozo-learning-review.js";
import { countsForLearning, dozoRecordLearningTurn } from "./dozo-learning-turn.js";
import type { RunContext } from "./run-context.js";

// When a finished run becomes a learning turn, and what it starts. The SQL itself is covered by
// dozo-learning-store.test.ts and, against a real database, dozo-learning.postgres.test.ts.

const { reviewLearning } = vi.hoisted(() => ({ reviewLearning: vi.fn(async () => undefined) }));
vi.mock("./dozo-learning-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dozo-learning-review.js")>()),
  reviewLearning,
}));

const { resolveRunModel, resolveConnectedRunModel } = vi.hoisted(() => ({
  resolveRunModel: vi.fn(async () => ({ provider: "test", id: "own" })),
  resolveConnectedRunModel: vi.fn(async () => ({ provider: "test", id: "role" })),
}));
vi.mock("./run-model.js", () => ({ resolveRunModel, resolveConnectedRunModel }));

const sqlOf = (call: unknown[]) => (call[0] as string[]).join("?");
const NOW = new Date("2027-01-16T12:00:00.000Z");

type Options = {
  mode?: "off" | "auto" | null;
  pending?: number;
  token?: boolean;
  tainted?: boolean;
  run?: Record<string, unknown>;
  thread?: Record<string, unknown>;
  source?: Record<string, unknown>;
};

function harness(options: Options = {}) {
  const { mode = "auto", pending = 1, token = false, tainted = false } = options;
  const queryRaw = vi.fn(async (...call: unknown[]) => {
    const sql = sqlOf(call);
    if (sql.includes("FROM dozo_bot_learning")) return mode ? [{ mode }] : [];
    if (sql.includes("count(*)")) return [{ pending }];
    return [{ sourced: token }];
  });
  const executeRaw = vi.fn(async (..._call: unknown[]) => 1);
  const enqueueIn = vi.fn(async () => undefined);
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw };
  const ctx = {
    runId: "run-1",
    run: {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      spaceId: "space-1",
      userId: "owner",
      trigger: "user",
      sourceMessageId: "message-1",
      ...options.run,
    },
    thread: {
      id: "thread-1",
      botId: "bot-1",
      groupId: null,
      externalConversationId: null,
      helperBotId: null,
      ...options.thread,
    },
    bot: { id: "bot-1", userId: "owner", spaceId: "space-1" },
    source: { ownerStartedRun: true, messagingChannelRun: false, ...options.source },
    state: { tainted },
    trust: { receivedOutsideMessage: async () => false },
    deps: {
      prisma: {
        ...tx,
        attempt: { count: async () => 1 },
        $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
      },
      jobs: { enqueueIn },
      runtime: {},
      memory: {},
    },
  } as unknown as RunContext;
  const started: Array<() => Promise<void>> = [];
  const start = vi.fn((work: () => Promise<void>) => {
    started.push(work);
  });
  return { ctx, queryRaw, executeRaw, enqueueIn, start, started };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  reviewLearning.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("dozoRecordLearningTurn", () => {
  it("with learning off reads the bot's row once and does nothing else", async () => {
    for (const mode of ["off", null] as const) {
      const off = harness({ mode });
      await dozoRecordLearningTurn(off.ctx, off.start);
      expect(off.queryRaw).toHaveBeenCalledOnce();
      expect(sqlOf(off.queryRaw.mock.calls[0]!)).toContain('WHERE "botId" = ?');
      expect(off.executeRaw).not.toHaveBeenCalled();
      expect(off.enqueueIn).not.toHaveBeenCalled();
      expect(off.start).not.toHaveBeenCalled();
    }
  });

  it("records the owner's turn and waits for a pause while fewer than ten wait", async () => {
    const few = harness({ pending: 9, tainted: true });
    await dozoRecordLearningTurn(few.ctx, few.start);
    const insert = few.executeRaw.mock.calls[0]!;
    expect(sqlOf(insert)).toContain("INSERT INTO dozo_learning_turns");
    expect(insert.slice(2)).toEqual(["bot-1", "space-1", "thread-1", "run-1", "message-1", true]);
    expect(few.enqueueIn).toHaveBeenCalledWith(expect.anything(), {
      name: "memory.learning-review",
      payload: { botId: "bot-1" },
      availableAt: new Date(NOW.getTime() + LEARNING_IDLE_MS),
      replaceKey: "learning.review:bot-1",
    });
    expect(few.start).not.toHaveBeenCalled();
  });

  it("at ten waiting turns adds the backup job and starts the review at once", async () => {
    const batch = harness({ pending: 10 });
    await dozoRecordLearningTurn(batch.ctx, batch.start);
    expect(batch.executeRaw.mock.calls[0]!.at(-1)).toBe(false);
    expect(batch.enqueueIn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        availableAt: new Date(NOW.getTime() + LEARNING_REVIEW_BACKUP_MS),
        replaceKey: "learning.review:bot-1",
      }),
    );
    expect(batch.start).toHaveBeenCalledOnce();
    await batch.started[0]!();
    expect(reviewLearning).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: batch.ctx.deps.prisma, memory: batch.ctx.deps.memory }),
      "bot-1",
    );
    // The review resolves models as the run's executor does.
    const [deps] = reviewLearning.mock.calls[0] as unknown as [LearningReviewDeps];
    const scope = { userId: "owner", spaceId: "space-1", botId: "bot-1" };
    expect(await deps.resolveModel(scope)).toEqual({ provider: "test", id: "own" });
    expect(await deps.resolveConnectedModel(scope, "test", "role")).toEqual({
      provider: "test",
      id: "role",
    });
    expect(resolveRunModel).toHaveBeenCalledWith(batch.ctx.deps, scope);
    expect(resolveConnectedRunModel).toHaveBeenCalledWith(batch.ctx.deps, scope, "test", "role");
  });

  it("a follow-up the owner sent counts as their turn", async () => {
    const followUp = harness({ run: { trigger: "follow_up" } });
    await dozoRecordLearningTurn(followUp.ctx, followUp.start);
    expect(followUp.enqueueIn).toHaveBeenCalledOnce();
  });

  it("records nothing for a run its owner's chat did not start, and reads nothing for it", async () => {
    const others: Options[] = [
      { source: { messagingChannelRun: true } },
      { run: { trigger: "messaging" }, source: { ownerStartedRun: false } },
      { run: { trigger: "webhook" }, source: { ownerStartedRun: false } },
      { run: { trigger: "routine" }, source: { ownerStartedRun: false } },
      { run: { trigger: "bot_message" }, source: { ownerStartedRun: false } },
      { run: { trigger: "background_helper" }, source: { ownerStartedRun: false } },
      { run: { trigger: "call_end" } },
      { run: { trigger: "follow_up" }, source: { ownerStartedRun: false } },
      { run: { userId: "another-member" } },
      { run: { sourceMessageId: null } },
      { thread: { botId: null, groupId: "group-1" } },
      { thread: { botId: null, helperBotId: "bot-1" } },
      { thread: { externalConversationId: "conversation-1" } },
      { thread: { botId: null } },
    ];
    for (const options of others) {
      const other = harness(options);
      expect(countsForLearning(other.ctx)).toBe(false);
      await dozoRecordLearningTurn(other.ctx, other.start);
      expect(other.queryRaw).not.toHaveBeenCalled();
      expect(other.enqueueIn).not.toHaveBeenCalled();
    }
  });

  it("records nothing for a run a token's message reached", async () => {
    const token = harness({ token: true });
    await dozoRecordLearningTurn(token.ctx, token.start);
    expect(token.executeRaw).not.toHaveBeenCalled();
    expect(token.enqueueIn).not.toHaveBeenCalled();
  });

  it("never fails the run", async () => {
    const broken = harness();
    broken.queryRaw.mockRejectedValueOnce(new Error("database down"));
    await expect(dozoRecordLearningTurn(broken.ctx, broken.start)).resolves.toBeUndefined();
    expect(broken.enqueueIn).not.toHaveBeenCalled();
  });

  it("starts the review in the background by default and never fails for it", async () => {
    reviewLearning.mockRejectedValueOnce(new Error("model down"));
    const batch = harness({ pending: 12 });
    await dozoRecordLearningTurn(batch.ctx);
    await vi.waitFor(() => expect(reviewLearning).toHaveBeenCalledOnce());
  });
});
