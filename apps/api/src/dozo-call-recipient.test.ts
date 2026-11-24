import type { Actor } from "@rakazo/contracts";
import { callRequestClientNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dozoAssertOwnCallNonce,
  dozoCallOwner,
  dozoNotCallRecipient,
  dozoSettleOwnCall,
} from "./dozo-call-recipient.js";

const mocks = vi.hoisted(() => ({ settleCallRequest: vi.fn() }));
vi.mock("@rakazo/adapters", () => ({ settleCallRequest: mocks.settleCallRequest }));

const actor = { userId: "user-me", spaceId: "space-1" } as Actor;

/** A chat holding a bot's call card in someone's chat, or the first turn someone said on a call. */
function fakePrisma(
  card: { thread: { userId: string } } | null,
  firstTurn: { authorUserId: string | null } | null = null,
) {
  const findUnique = vi.fn(async (_args: unknown) => card);
  const findFirst = vi.fn(async (_args: unknown) => firstTurn);
  return {
    prisma: { message: { findUnique, findFirst } } as unknown as PrismaClient,
    findUnique,
    findFirst,
  };
}

const input = { threadId: "thread-1", callId: "call-1" } as Parameters<typeof dozoSettleOwnCall>[2];

beforeEach(() => {
  mocks.settleCallRequest.mockReset();
  mocks.settleCallRequest.mockResolvedValue({ settled: true });
});

describe("dozoCallOwner", () => {
  it("is the person whose chat holds the bot's call card", async () => {
    const { prisma, findUnique, findFirst } = fakePrisma({ thread: { userId: "user-owner" } });
    expect(await dozoCallOwner(prisma, "thread-1", "call-1")).toBe("user-owner");
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        threadId_clientNonce: {
          threadId: "thread-1",
          clientNonce: callRequestClientNonce("call-1"),
        },
      },
      select: { thread: { select: { userId: true } } },
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("is who spoke first on a call a person started", async () => {
    const { prisma, findFirst } = fakePrisma(null, { authorUserId: "user-caller" });
    expect(await dozoCallOwner(prisma, "thread-1", "call-1")).toBe("user-caller");
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        threadId: "thread-1",
        role: "user",
        authorUserId: { not: null },
        clientNonce: { startsWith: "call:call-1:" },
      },
      orderBy: { seq: "asc" },
      select: { authorUserId: true },
    });
  });

  it("is null while nothing of the call is in the chat", async () => {
    const { prisma } = fakePrisma(null);
    expect(await dozoCallOwner(prisma, "thread-1", "call-1")).toBeNull();
  });
});

describe("dozoNotCallRecipient", () => {
  it("is false for the person whose chat it is", async () => {
    const { prisma } = fakePrisma({ thread: { userId: "user-me" } });
    expect(await dozoNotCallRecipient(prisma, actor, "thread-1", "call-1")).toBe(false);
  });

  it("is true for someone else in the Space", async () => {
    const { prisma } = fakePrisma({ thread: { userId: "user-other" } });
    expect(await dozoNotCallRecipient(prisma, actor, "thread-1", "call-1")).toBe(true);
  });

  it("is true for someone else on a call a person started", async () => {
    const { prisma } = fakePrisma(null, { authorUserId: "user-other" });
    expect(await dozoNotCallRecipient(prisma, actor, "thread-1", "call-1")).toBe(true);
  });

  it("is false when there is no such call", async () => {
    const { prisma } = fakePrisma(null);
    expect(await dozoNotCallRecipient(prisma, actor, "thread-1", "call-1")).toBe(false);
  });
});

describe("dozoSettleOwnCall", () => {
  it("settles the call for its recipient and returns the answer", async () => {
    const { prisma } = fakePrisma({ thread: { userId: "user-me" } });
    const deps = { prisma } as Parameters<typeof dozoSettleOwnCall>[0];
    expect(await dozoSettleOwnCall(deps, actor, input)).toEqual({ settled: true });
    expect(mocks.settleCallRequest).toHaveBeenCalledWith(deps, input);
  });

  it("leaves the call alone and answers null for someone else", async () => {
    const { prisma } = fakePrisma({ thread: { userId: "user-other" } });
    const deps = { prisma } as Parameters<typeof dozoSettleOwnCall>[0];
    expect(await dozoSettleOwnCall(deps, actor, input)).toBeNull();
    expect(mocks.settleCallRequest).not.toHaveBeenCalled();
  });

  it("falls through to settle when there is no such call", async () => {
    const { prisma } = fakePrisma(null);
    const deps = { prisma } as Parameters<typeof dozoSettleOwnCall>[0];
    mocks.settleCallRequest.mockResolvedValue(null);
    expect(await dozoSettleOwnCall(deps, actor, input)).toBeNull();
    expect(mocks.settleCallRequest).toHaveBeenCalledWith(deps, input);
  });
});

describe("dozoAssertOwnCallNonce", () => {
  it("lets any nonce that names no call through without a lookup", async () => {
    const { prisma, findUnique } = fakePrisma({ thread: { userId: "user-other" } });
    for (const nonce of [undefined, "plain-nonce", "call:no-suffix"])
      await expect(dozoAssertOwnCallNonce(prisma, actor, "thread-1", nonce)).resolves.toBe(
        undefined,
      );
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("lets the person on the call, or a new call, add to it", async () => {
    const own = fakePrisma({ thread: { userId: "user-me" } });
    await expect(
      dozoAssertOwnCallNonce(own.prisma, actor, "thread-1", "call:call-1:turn"),
    ).resolves.toBe(undefined);
    const fresh = fakePrisma(null);
    await expect(
      dozoAssertOwnCallNonce(fresh.prisma, actor, "thread-1", "call:call-2:turn"),
    ).resolves.toBe(undefined);
  });

  it("refuses someone else's call as not found", async () => {
    const card = fakePrisma({ thread: { userId: "user-other" } });
    await expect(
      dozoAssertOwnCallNonce(card.prisma, actor, "thread-1", "call:call-1:turn"),
    ).rejects.toBeInstanceOf(IsolationError);
    const started = fakePrisma(null, { authorUserId: "user-other" });
    await expect(
      dozoAssertOwnCallNonce(started.prisma, actor, "thread-1", "call:call-1:turn"),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("refuses a call id no client makes, without a lookup", async () => {
    const { prisma, findUnique } = fakePrisma(null);
    await expect(
      dozoAssertOwnCallNonce(prisma, actor, "thread-1", "call:call-1:x:turn"),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
