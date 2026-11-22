import { ORPCError } from "@orpc/server";
import type { ProductEvent } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { dozoWhileMember } from "./dozo-stream-membership.js";

const actor = { spaceId: "space-1", userId: "user-1" };

function event(seq: number): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: actor.spaceId,
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type: "thread.message.created",
    createdAt: new Date(0).toISOString(),
    payload: {},
  };
}

/** A membership lookup answering from `answers` in turn. */
function lookups(...answers: Array<{ member: boolean; seq: number | null }>) {
  const $queryRaw = vi.fn(async () => {
    const next = answers.shift();
    if (!next) throw new Error("unexpected lookup");
    return [next];
  });
  return { $queryRaw } as unknown as Parameters<typeof dozoWhileMember>[0] & {
    $queryRaw: typeof $queryRaw;
  };
}

async function* source(events: ProductEvent[], closed: { done: boolean }) {
  try {
    yield* events;
  } finally {
    closed.done = true;
  }
}

async function collect(stream: AsyncGenerator<ProductEvent>) {
  const seen: number[] = [];
  for await (const next of stream) seen.push(next.seq);
  return seen;
}

describe("dozoWhileMember", () => {
  it("checks once for everything the chat held at the check, and again for anything newer", async () => {
    const prisma = lookups({ member: true, seq: 3 }, { member: true, seq: 5 });
    const closed = { done: false };
    const stream = dozoWhileMember(
      prisma,
      actor,
      "thread-1",
      source([1, 2, 3, 4, 5].map(event), closed),
    );
    expect(await collect(stream)).toEqual([1, 2, 3, 4, 5]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("covers the event it checks for when the chat reads as empty", async () => {
    const prisma = lookups({ member: true, seq: null }, { member: true, seq: 2 });
    const stream = dozoWhileMember(
      prisma,
      actor,
      "thread-1",
      source([event(1), event(2)], { done: false }),
    );
    expect(await collect(stream)).toEqual([1, 2]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("ends unauthorized before an event newer than the check once the person is gone", async () => {
    const prisma = lookups({ member: true, seq: 1 }, { member: false, seq: 2 });
    const closed = { done: false };
    const seen: number[] = [];
    const stream = dozoWhileMember(prisma, actor, "thread-1", source([event(1), event(2)], closed));
    const failure = await (async () => {
      for await (const next of stream) seen.push(next.seq);
    })().catch((error: unknown) => error);
    expect(seen).toEqual([1]);
    expect(failure).toBeInstanceOf(ORPCError);
    expect((failure as ORPCError<string, unknown>).code).toBe("UNAUTHORIZED");
    expect(closed.done).toBe(true);
  });

  it("closes its source at once, even while a read waits", async () => {
    const waiting = {
      next: () => new Promise<IteratorResult<ProductEvent>>(() => {}),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    } as unknown as AsyncGenerator<ProductEvent>;
    const stream = dozoWhileMember(lookups(), actor, "thread-1", waiting);
    void stream.next();
    await stream.return(undefined);
    expect(waiting.return).toHaveBeenCalled();
  });
});
