import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import { createReplyState } from "./run-progress.js";
import { completeRun } from "./run-turn.js";

// The branded run turn, where a tainted run's turn is not retained (dozo/brand/brand.json). Runs
// on the staged tree.

vi.mock("./dozo-token-run.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runCameByToken: async () => false,
}));
vi.mock("./dozo-phone.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runReadPhone: async () => false,
}));

async function finishedTurn(options: {
  tainted?: boolean;
  attempts?: number;
  outsideMessage?: boolean;
}) {
  const enqueue = vi.fn(async (_job: { name: string }) => undefined);
  const tx = { usageRecord: { createMany: async () => ({ count: 0 }) } };
  const deps = {
    prisma: {
      attempt: { count: async () => options.attempts ?? 1 },
      message: { findMany: async () => [] },
      run: { updateMany: async () => ({ count: 1 }) },
      steeringMessage: { findMany: async () => [] },
      thread: {
        findUniqueOrThrow: async () => ({ nextMessageSeq: 0, historyCompactedUpToSeq: null }),
      },
      $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    },
    events: { append: vi.fn(), finalizeRun: async () => ({}) },
    jobs: { enqueue },
  };
  const run = {
    id: "run-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    threadId: "thread-1",
    taskId: "task-1",
    trigger: "user",
    sourceMessageId: "message-1",
    clientNonce: null,
  };
  const reply = await createReplyState(deps as never, run as never, []);
  const ctx = {
    deps,
    run,
    runId: run.id,
    workerId: "worker-1",
    fence: 1,
    bot: { id: run.botId },
    thread: { id: run.threadId, botId: run.botId, groupId: null },
    attempt: { id: "attempt-1" },
    state: {
      reply,
      tainted: Boolean(options.tainted),
      approval: { pausePending: false },
      lease: { valid: true, lastCheckAt: Date.now() },
      computerUse: {},
    },
    abortController: new AbortController(),
    computer: { lazy: { throwIfFailed: () => {} }, checkpoint: { flush: vi.fn() } },
    tools: { approvedReplays: { assertDrained: () => {} } },
    source: {},
    trust: { receivedOutsideMessage: async () => options.outsideMessage ?? false },
    memory: { semantic: { retainConversation: async () => undefined }, scope: "isolated" },
    secrets: [],
    allowSilentEmptyRun: true,
    settleRunningHelpers: async () => {},
    stopHeartbeatAfterCompletion: () => {},
  } as unknown as RunContext;
  await completeRun(ctx);
  return enqueue.mock.calls.map(([job]) => job.name);
}

describe("conversation memory after outside content", () => {
  it("retains the turn of the owner's clean run", async () => {
    expect(await finishedTurn({})).toContain("memory.retain-turn");
  });

  it("retains no turn of a run that read outside content or that someone else started", async () => {
    // A run someone else started starts tainted, as one that read outside content becomes.
    expect(await finishedTurn({ tainted: true })).not.toContain("memory.retain-turn");
  });

  it("retains no turn of a run an outside message reached or that ran before", async () => {
    expect(await finishedTurn({ outsideMessage: true })).not.toContain("memory.retain-turn");
    expect(await finishedTurn({ attempts: 2 })).not.toContain("memory.retain-turn");
  });
});
