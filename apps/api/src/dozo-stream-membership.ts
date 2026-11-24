import { ORPCError } from "@orpc/server";
import type { Actor, ProductEvent } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/**
 * A chat's events for as long as the caller is still a member of its Space. The session is
 * re-checked only every few seconds, and a member removed in between must not see what is written
 * after the removal. So before an event newer than the last check, one statement reads the
 * membership and the chat's newest event: everything up to that event was written while the
 * caller was a member and passes without another read, so a burst costs one query. A caller who
 * is no longer a member ends the stream as a signed-out session does.
 *
 * Not a generator: closing it closes `events` at once, even while a read is waiting, as closing
 * `events` itself would.
 */
export function dozoWhileMember(
  prisma: Pick<PrismaClient, "$queryRaw">,
  actor: Pick<Actor, "spaceId" | "userId">,
  threadId: string,
  events: AsyncGenerator<ProductEvent>,
): AsyncGenerator<ProductEvent> {
  let checkedThrough = Number.NEGATIVE_INFINITY;
  const stillMember = async (event: ProductEvent) => {
    const [row] = await prisma.$queryRaw<Array<{ member: boolean; seq: number | null }>>`
      SELECT
        EXISTS (
          SELECT 1 FROM "space_members"
          WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}
        ) AS member,
        (SELECT max("seq") FROM "events" WHERE "threadId" = ${threadId}) AS seq
    `;
    if (!row?.member) return false;
    checkedThrough = Math.max(event.seq, row.seq ?? event.seq);
    return true;
  };
  const stream: AsyncGenerator<ProductEvent> = {
    async next() {
      const next = await events.next();
      if (next.done || next.value.seq <= checkedThrough) return next;
      if (await stillMember(next.value)) return next;
      await events.return(undefined);
      throw new ORPCError("UNAUTHORIZED");
    },
    return: (value) => events.return(value),
    throw: (error) => events.throw(error),
    [Symbol.asyncIterator]: () => stream,
    [Symbol.asyncDispose]: async () => {
      await events.return(undefined);
    },
  };
  return stream;
}
