import { settleCallRequest } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  CALL_CLIENT_NONCE_PREFIX,
  callIdFromClientNonce,
  callRequestClientNonce,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";

/**
 * Whose call `callId` is: a bot's call rings the person whose chat it is; a call a person started
 * has no card and is theirs, the one who spoke on it first. Null while nothing of it is in the chat.
 */
export async function dozoCallOwner(
  prisma: PrismaClient,
  threadId: string,
  callId: string,
): Promise<string | null> {
  const card = await prisma.message.findUnique({
    where: { threadId_clientNonce: { threadId, clientNonce: callRequestClientNonce(callId) } },
    select: { thread: { select: { userId: true } } },
  });
  if (card) return card.thread.userId;
  const firstTurn = await prisma.message.findFirst({
    where: {
      threadId,
      role: "user",
      authorUserId: { not: null },
      clientNonce: { startsWith: `${CALL_CLIENT_NONCE_PREFIX}${callId}:` },
    },
    orderBy: { seq: "asc" },
    select: { authorUserId: true },
  });
  return firstTurn?.authorUserId ?? null;
}

/**
 * A call is on for one person. Anyone else in the Space sees its messages but is not on it:
 * true when `callId` is such a call and `actor` is not that person.
 */
export async function dozoNotCallRecipient(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
  callId: string,
): Promise<boolean> {
  const owner = await dozoCallOwner(prisma, threadId, callId);
  return owner !== null && owner !== actor.userId;
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

/**
 * A message whose nonce names a call joins that call's conversation, so only the person on the
 * call may send one; a call id no client makes (one with ":") is refused the same way.
 */
export async function dozoAssertOwnCallNonce(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
  clientNonce: string | undefined,
): Promise<void> {
  const callId = callIdFromClientNonce(clientNonce);
  if (!callId) return;
  if (callId.includes(":") || (await dozoNotCallRecipient(prisma, actor, threadId, callId)))
    throw new IsolationError();
}
