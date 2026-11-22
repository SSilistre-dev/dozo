import { settleCallRequest } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { callRequestClientNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/**
 * A bot's call rings one person, the one whose chat it is. Anyone else in the Space sees the card
 * but is not on the call: true when `callId` is such a call and `actor` is not that person.
 */
export async function dozoNotCallRecipient(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
  callId: string,
): Promise<boolean> {
  const card = await prisma.message.findUnique({
    where: { threadId_clientNonce: { threadId, clientNonce: callRequestClientNonce(callId) } },
    select: { thread: { select: { userId: true } } },
  });
  return Boolean(card) && card?.thread.userId !== actor.userId;
}

/**
 * `settleCallRequest` for the call's own recipient; for anyone else the call is left as it is and
 * the answer is the one an unknown call gets (null).
 */
export async function dozoSettleOwnCall(
  deps: Parameters<typeof settleCallRequest>[0],
  actor: Actor,
  input: Parameters<typeof settleCallRequest>[1],
) {
  if (await dozoNotCallRecipient(deps.prisma, actor, input.threadId, input.callId)) return null;
  return settleCallRequest(deps, input);
}
