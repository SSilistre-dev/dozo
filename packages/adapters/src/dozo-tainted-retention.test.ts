import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./runs/assembly/run-context.js";
import { markReadOutsideContent } from "./runs/assembly/run-context.js";
import { createReplyState } from "./runs/lifecycle/run-progress.js";
import { completeRun } from "./runs/turn/run-turn.js";

// The branded run turn, where the turn of a run that read outside content is not retained
// (dozo/brand/brand.json). Runs on the staged tree.

vi.mock("./dozo-token-run.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runCameByToken: async () => false,
}));
vi.mock("./dozo-phone.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runReadPhone: async () => false,
}));

async function finishedTurn(options: {
  trigger?: string;
  /** Someone other than the owner wrote in this connected chat. */
  nonOwnerChat?: boolean;
  /** A tool result brought outside content in, as a fetched page does. */
  read?: boolean;
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
    trigger: options.trigger ?? "user",
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
      // A run someone else started begins tainted, before it reads anything.
      tainted: (options.trigger ?? "user") !== "user",
      earlierAttempt: undefined,
      approval: { pausePending: false },
      lease: { valid: true, lastCheckAt: Date.now() },
      computerUse: {},
    },
    abortController: new AbortController(),
    computer: { lazy: { throwIfFailed: () => {} }, checkpoint: { flush: vi.fn() } },
    tools: { approvedReplays: { assertDrained: () => {} } },
    source: { messagingChannelRun: Boolean(options.nonOwnerChat) },
    trust: { receivedOutsideMessage: async () => options.outsideMessage ?? false },
    memory: { semantic: { retainConversation: async () => undefined }, scope: "isolated" },
    secrets: [],
    allowSilentEmptyRun: true,
    settleRunningHelpers: async () => {},
    stopHeartbeatAfterCompletion: () => {},
  } as unknown as RunContext;
  if (options.read) await markReadOutsideContent(ctx);
  await completeRun(ctx);
  return enqueue.mock.calls.map(([job]) => job.name);
}

const RETAINED = "memory.retain-turn";

describe("conversation memory after outside content", () => {
  it("retains the turn of the owner's clean run", async () => {
    expect(await finishedTurn({})).toContain(RETAINED);
  });

  it("retains no turn of the owner's run that read a page", async () => {
    expect(await finishedTurn({ read: true })).not.toContain(RETAINED);
  });

  it("retains a turn from the owner's own connected chat app that read nothing", async () => {
    expect(await finishedTurn({ trigger: "messaging" })).toContain(RETAINED);
  });

  it("retains no turn from that chat app once it read a page", async () => {
    expect(await finishedTurn({ trigger: "messaging", read: true })).not.toContain(RETAINED);
  });

  it("retains another bot's turn that read nothing, so bots keep learning from each other", async () => {
    expect(await finishedTurn({ trigger: "bot_message" })).toContain(RETAINED);
    expect(await finishedTurn({ trigger: "bot_message", read: true })).not.toContain(RETAINED);
  });

  it("still retains nothing of someone else's chat, as upstream", async () => {
    expect(await finishedTurn({ trigger: "messaging", nonOwnerChat: true })).not.toContain(
      RETAINED,
    );
  });

  it("retains no turn of a run an outside message reached or that ran before", async () => {
    expect(await finishedTurn({ outsideMessage: true })).not.toContain(RETAINED);
    expect(await finishedTurn({ attempts: 2 })).not.toContain(RETAINED);
  });
});
