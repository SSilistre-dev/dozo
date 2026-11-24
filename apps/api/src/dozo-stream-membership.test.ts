import { ORPCError } from "@orpc/server";
import type { ProductEvent } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { dozoEnsureStreamCaller, dozoWhileMember } from "./dozo-stream-membership.js";

const actor = { spaceId: "space-1", userId: "user-1" };
const caller = { actor, sessionId: "session-1" };

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
function lookups(...answers: Array<Record<string, unknown>>) {
  const $queryRaw = vi.fn(async (_query: Prisma.Sql) => {
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
    for (const next of events) yield next;
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
      caller,
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
      caller,
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
    const stream = dozoWhileMember(
      prisma,
      caller,
      "thread-1",
      source([event(1), event(2)], closed),
    );
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
    const stream = dozoWhileMember(lookups(), caller, "thread-1", waiting);
    void stream.next();
    await stream.return(undefined);
    expect(waiting.return).toHaveBeenCalled();
  });

  it("forwards a thrown error to its source", async () => {
    const closed = { done: false };
    const stream = dozoWhileMember(
      lookups({ member: true, seq: 1 }),
      caller,
      "thread-1",
      source([event(1)], closed),
    );
    await stream.next();
    const failure = new Error("client gave up");
    await expect(stream.throw(failure)).rejects.toBe(failure);
    expect(closed.done).toBe(true);
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });

  it("is its own iterator, so a for-await loop reads it", async () => {
    const stream = dozoWhileMember(
      lookups({ member: true, seq: 2 }),
      caller,
      "thread-1",
      source([event(1), event(2)], { done: false }),
    );
    expect(stream[Symbol.asyncIterator]()).toBe(stream);
    expect(await collect(stream)).toEqual([1, 2]);
  });

  it("closes its source when disposed", async () => {
    const closed = { done: false };
    const stream = dozoWhileMember(
      lookups({ member: true, seq: 1 }),
      caller,
      "thread-1",
      source([event(1)], closed),
    );
    await stream.next();
    await stream[Symbol.asyncDispose]();
    expect(closed.done).toBe(true);
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });

  it("asks for the session it was opened with, read as the system", async () => {
    const prisma = lookups({ member: true, seq: 1 });
    await dozoWhileMember(prisma, caller, "thread-1", source([event(1)], { done: false })).next();
    const query = prisma.$queryRaw.mock.calls[0]![0];
    expect(query.sql).toContain('FROM "session"');
    expect(query.sql).toContain('"deactivatedAt" IS NULL');
    expect(query.sql).not.toContain("dozo_access_tokens");
    expect(query.values).toEqual(expect.arrayContaining(["session-1", "user-1", "thread-1"]));
  });
});

describe("dozoEnsureStreamCaller", () => {
  it("passes a caller who may still read the Space", async () => {
    const prisma = lookups({ allowed: true });
    await dozoEnsureStreamCaller(prisma, { actor, dozoAccessTokenId: "token-1" });
    const query = prisma.$queryRaw.mock.calls[0]![0];
    expect(query.sql).toContain("dozo_access_tokens");
    expect(query.sql).not.toContain('FROM "session"');
    expect(query.values).toContain("token-1");
  });

  it("ends unauthorized once the caller may not", async () => {
    const failure = await dozoEnsureStreamCaller(lookups({ allowed: false }), caller).catch(
      (error: unknown) => error,
    );
    expect((failure as ORPCError<string, unknown>).code).toBe("UNAUTHORIZED");
  });

  it("never passes a caller with neither a session nor a token", async () => {
    const prisma = lookups({ allowed: false });
    await expect(dozoEnsureStreamCaller(prisma, { actor })).rejects.toBeInstanceOf(ORPCError);
    expect(prisma.$queryRaw.mock.calls[0]![0].sql).toContain("FALSE");
  });
});
