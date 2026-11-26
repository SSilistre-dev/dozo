import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./database/client.js";
import { answerRunInput } from "./threads/thread-ask.js";

/**
 * A client that sends an answer again (its first try may have been lost on the way) must not apply
 * the card twice. The card's own state is the guard: a run answers once, from `waiting_input`, so
 * the second answer finds nothing to answer whatever `clientNonce` it carries.
 */
function pendingApprovalCard() {
  const state = {
    runStatus: "waiting_input",
    effectStatus: "intended",
    blocks: [
      {
        kind: "ask",
        approvalEffectId: "effect-1",
        text: "Run on your computer?",
        status: "pending",
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "deny", label: "Deny" },
        ],
      },
    ] as Array<Record<string, unknown>>,
    nextSeq: 10,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
    message: {
      findFirst: vi.fn(async () => ({ id: "message-1", blocks: state.blocks })),
      update: vi.fn(async ({ data }: { data: { blocks: typeof state.blocks } }) => {
        state.blocks = data.blocks;
        return { id: "message-1" };
      }),
    },
    run: {
      findFirst: vi.fn(async ({ where }: { where: { status: string } }) =>
        where.status === state.runStatus ? { botId: "bot-1", userId: "user-1" } : null,
      ),
      updateMany: vi.fn(async ({ where }: { where: { status: string } }) => {
        if (where.status !== state.runStatus) return { count: 0 };
        state.runStatus = "queued";
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => ({ status: state.runStatus })),
    },
    task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    externalEffect: {
      findFirst: vi.fn(async ({ where }: { where: { status: string } }) =>
        where.status === state.effectStatus
          ? { id: "effect-1", kind: "run_on_device", status: state.effectStatus }
          : null,
      ),
      update: vi.fn(async ({ data }: { data: { status: string } }) => {
        state.effectStatus = data.status;
        return { id: "effect-1" };
      }),
    },
    thread: { update: vi.fn(async () => ({ nextEventSeq: ++state.nextSeq })) },
    event: {
      create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
        id: `event-${data.seq}`,
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: null,
        payload: {},
        createdAt: new Date("2026-11-20T12:00:00.000Z"),
        ...data,
      })),
    },
  };
  const prisma = {
    $transaction: async (work: (client: typeof tx) => unknown) => work(tx),
  } as unknown as PrismaClient;
  return { tx, prisma, state };
}

const answer = {
  spaceId: "workspace-1",
  threadId: "thread-1",
  runId: "run-1",
  messageId: "message-1",
  answeredByUserId: "user-1",
  answer: "allow",
};

describe("answering the same approval card twice", () => {
  it.each([
    ["no nonce", undefined],
    ["the same nonce", "click-1"],
  ])("applies it once and refuses the repeat with %s", async (_, clientNonce) => {
    const { tx, prisma, state } = pendingApprovalCard();
    const input = { ...answer, ...(clientNonce ? { clientNonce } : {}) };

    await expect(answerRunInput(prisma, input)).resolves.toBe(true);
    await expect(answerRunInput(prisma, input)).resolves.toBe(false);
    await expect(answerRunInput(prisma, { ...answer, answer: "deny" })).resolves.toBe(false);

    expect(state.runStatus).toBe("queued");
    expect(state.effectStatus).toBe("approved");
    expect(tx.run.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.externalEffect.update).toHaveBeenCalledTimes(1);
    expect(tx.message.update).toHaveBeenCalledTimes(1);
    expect(tx.event.create).toHaveBeenCalledTimes(1);
  });
});
