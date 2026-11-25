import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./database/client.js";
import { sendUserMessage } from "./threads/events.js";

/**
 * The line of waiting work is re-read when the Space signals a change in its runs. A message sent
 * behind a busy run waits in line and starts no run of its own, so it has to signal too.
 */
function sendBehind(busyRun: { id: string; trigger: string; userId: string }) {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    space: { findUnique: vi.fn() },
    thread: {
      update: vi
        .fn()
        .mockResolvedValueOnce({ nextMessageSeq: 5 })
        .mockResolvedValueOnce({ nextEventSeq: 9 }),
    },
    message: {
      create: vi.fn().mockResolvedValue({ id: "message-1", seq: 4 }),
      update: vi.fn().mockResolvedValue({ id: "message-1" }),
    },
    steeringMessage: { create: vi.fn() },
    task: { create: vi.fn() },
    run: {
      findMany: vi.fn().mockResolvedValue([{ ...busyRun, taskId: "task-busy", status: "running" }]),
      findUnique: vi.fn().mockResolvedValue({ status: "running" }),
      create: vi.fn(),
    },
    event: {
      create: vi.fn(async ({ data }: { data: { seq: number; type: string } }) => ({
        id: `event-${data.seq}`,
        spaceId: "workspace-1",
        threadId: "thread-1",
        botId: "bot-1",
        seq: data.seq,
        type: data.type,
        payload: {},
        runId: null,
        createdAt: new Date("2026-08-15T12:00:00.000Z"),
      })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaClient;
  const publish = vi.fn(async (_topic: string, _payload: string) => undefined);
  const sent = sendUserMessage(
    prisma,
    {
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      blocks: [{ kind: "text", text: "ping" }],
      prompt: "ping",
      trigger: "user",
    },
    { publish } as never,
  );
  return { tx, publish, sent };
}

describe("a message held behind a busy run", () => {
  it("is held in line, starts no run, and signals the Space that its runs changed", async () => {
    const { tx, publish, sent } = sendBehind({
      id: "run-routine",
      trigger: "routine",
      userId: "user-1",
    });
    await expect(sent).resolves.toMatchObject({ runId: "run-routine" });
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.steeringMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ messageId: "message-1", runId: null }),
    });
    expect(publish.mock.calls.map(([topic]) => topic)).toContain("space-changes:workspace-1");
  });
});
