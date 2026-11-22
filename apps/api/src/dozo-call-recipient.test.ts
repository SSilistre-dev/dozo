import type { Actor } from "@rakazo/contracts";
import { callRequestClientNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoNotCallRecipient, dozoSettleOwnCall } from "./dozo-call-recipient.js";

const mocks = vi.hoisted(() => ({ settleCallRequest: vi.fn() }));
vi.mock("@rakazo/adapters", () => ({ settleCallRequest: mocks.settleCallRequest }));

const actor = { userId: "user-me", spaceId: "space-1" } as Actor;

function fakePrisma(card: { thread: { userId: string } } | null) {
  const findUnique = vi.fn(async (_args: unknown) => card);
  return { prisma: { message: { findUnique } } as unknown as PrismaClient, findUnique };
}

const input = { threadId: "thread-1", callId: "call-1" } as Parameters<typeof dozoSettleOwnCall>[2];

beforeEach(() => {
  mocks.settleCallRequest.mockReset();
  mocks.settleCallRequest.mockResolvedValue({ settled: true });
});

describe("dozoNotCallRecipient", () => {
  it("looks the card up by the call's own nonce in that thread", async () => {
    const { prisma, findUnique } = fakePrisma({ thread: { userId: "user-me" } });
    await dozoNotCallRecipient(prisma, actor, "thread-1", "call-1");
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        threadId_clientNonce: {
          threadId: "thread-1",
          clientNonce: callRequestClientNonce("call-1"),
        },
      },
      select: { thread: { select: { userId: true } } },
    });
  });

  it("is false for the person whose chat it is", async () => {
    const { prisma } = fakePrisma({ thread: { userId: "user-me" } });
    expect(await dozoNotCallRecipient(prisma, actor, "thread-1", "call-1")).toBe(false);
  });

  it("is true for someone else in the Space", async () => {
    const { prisma } = fakePrisma({ thread: { userId: "user-other" } });
    expect(await dozoNotCallRecipient(prisma, actor, "thread-1", "call-1")).toBe(true);
  });

  it("is false when there is no such call card", async () => {
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

  it("falls through to settle when there is no call card (a call the user started)", async () => {
    const { prisma } = fakePrisma(null);
    const deps = { prisma } as Parameters<typeof dozoSettleOwnCall>[0];
    mocks.settleCallRequest.mockResolvedValue(null);
    expect(await dozoSettleOwnCall(deps, actor, input)).toBeNull();
    expect(mocks.settleCallRequest).toHaveBeenCalledWith(deps, input);
  });
});
