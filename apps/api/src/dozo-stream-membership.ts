import { ORPCError } from "@orpc/server";
import type { Actor, ProductEvent } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { dozoAccessTokenStillValid, Prisma, runAsSystem } from "@rakazo/db";

/** Who an open stream answers to, and what they signed in with. */
export type DozoStreamCaller = {
  actor: Pick<Actor, "spaceId" | "userId">;
  /** The app's: the session the stream was opened with. */
  sessionId?: string;
  /** The Bot API's and MCP's: the access token the call came with. */
  dozoAccessTokenId?: string;
};

type Db = Pick<PrismaClient, "$queryRaw">;

/**
 * The caller may still read the Space: still a member, the account not deactivated (a ban
 * deactivates it), and what they signed in with still holds. A session is gone once its person
 * signs out, signs out other sessions, changes the password or is signed out by an operator; a
 * token ends with "sign out everywhere", a password change or an operator's revocation. A caller
 * with neither is never allowed: every way in carries one.
 */
function allowed({ actor, sessionId, dozoAccessTokenId }: DozoStreamCaller): Prisma.Sql {
  const conditions = [
    Prisma.sql`EXISTS (SELECT 1 FROM "space_members"
      WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId})`,
    Prisma.sql`EXISTS (SELECT 1 FROM "user" WHERE id = ${actor.userId} AND "deactivatedAt" IS NULL)`,
  ];
  if (sessionId)
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "session"
      WHERE id = ${sessionId} AND "userId" = ${actor.userId}
        AND "expiresAt" > CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`);
  if (dozoAccessTokenId) conditions.push(dozoAccessTokenStillValid(dozoAccessTokenId, actor));
  if (!sessionId && !dozoAccessTokenId) conditions.push(Prisma.sql`FALSE`);
  return Prisma.join(conditions, " AND ");
}

/** One statement, read as the system: the security log a token's revocation is in is not the Space's. */
function read<T>(prisma: Db, query: Prisma.Sql) {
  return runAsSystem("check an open stream's caller", () => prisma.$queryRaw<T>(query));
}

/**
 * Ends the stream as a signed-out session does unless the caller may still read the Space. For a
 * rare event, such as a chat alert, checked before each one.
 */
export async function dozoEnsureStreamCaller(prisma: Db, caller: DozoStreamCaller): Promise<void> {
  const [row] = await read<Array<{ allowed: boolean }>>(
    prisma,
    Prisma.sql`SELECT (${allowed(caller)}) AS allowed`,
  );
  if (!row?.allowed) throw new ORPCError("UNAUTHORIZED");
}

/**
 * A chat's events for as long as the caller may still read its Space. The session is re-checked
 * only every few seconds, and a member removed, signed out or deactivated in between must not see
 * what is written after that. So before an event newer than the last check, one statement reads
 * whether the caller is still allowed and the chat's newest event: everything up to that event
 * was written while they were, and passes without another read, so a burst costs one query. A
 * caller no longer allowed ends the stream as a signed-out session does.
 *
 * Not a generator: closing it closes `events` at once, even while a read is waiting, as closing
 * `events` itself would.
 */
export function dozoWhileMember(
  prisma: Db,
  caller: DozoStreamCaller,
  threadId: string,
  events: AsyncGenerator<ProductEvent>,
): AsyncGenerator<ProductEvent> {
  let checkedThrough = Number.NEGATIVE_INFINITY;
  const stillMember = async (event: ProductEvent) => {
    const [row] = await read<Array<{ member: boolean; seq: number | null }>>(
      prisma,
      Prisma.sql`SELECT (${allowed(caller)}) AS member,
        (SELECT max("seq") FROM "events" WHERE "threadId" = ${threadId}) AS seq`,
    );
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
