import { setImmediate } from "node:timers";
import { ORPCError } from "@orpc/server";
import type { Actor, ProductEvent } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { dozoAccessTokenStillValid, Prisma, runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

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
  if (!(await stillAllowed(prisma, caller))) throw new ORPCError("UNAUTHORIZED");
}

async function stillAllowed(prisma: Db, caller: DozoStreamCaller) {
  const [row] = await read<Array<{ allowed: boolean }>>(
    prisma,
    Prisma.sql`SELECT (${allowed(caller)}) AS allowed`,
  );
  return Boolean(row?.allowed);
}

/** The most frames one check lets through at once. */
const BATCH_LIMIT = 100;
const NOT_READY = Symbol("not ready");
const FAILED = Symbol("failed");

/**
 * One turn of the event loop, from the timers module so a test's fake clock cannot hold it: a
 * frame the source already holds arrives before it ends.
 */
const oneTurn = () => new Promise<typeof NOT_READY>((resolve) => setImmediate(resolve, NOT_READY));

/**
 * A live stream's frames for as long as the caller may still read its Space, for frames with no
 * chat sequence to check against: board changes, roster and Space change signals, chat alerts.
 * Before passing a frame on it takes every frame the source already holds behind it, then checks
 * once and passes them all, so a burst costs one query. Each frame it passes was there before a
 * check that found the caller allowed; one that arrives during the check waits for the next. A
 * caller no longer allowed ends the stream as a signed-out session does.
 *
 * Not a generator: closing it closes `frames` at once, even while a read is waiting.
 */
export function dozoWhileAllowed<T>(
  prisma: Db,
  caller: DozoStreamCaller,
  frames: AsyncGenerator<T>,
): AsyncGenerator<T> {
  let checked: T[] = [];
  let ended: IteratorResult<T> | undefined;
  let waiting: Promise<IteratorResult<T>> | undefined;
  const held = async (): Promise<T[]> => {
    const read = waiting ?? frames.next();
    waiting = undefined;
    const first = await read;
    if (first.done) {
      ended = first;
      return [];
    }
    const batch = [first.value];
    while (batch.length < BATCH_LIMIT) {
      const next = frames.next();
      // A failed read is kept for the next call, so the frames before it still go out first.
      const settled = await Promise.race([next.catch((): typeof FAILED => FAILED), oneTurn()]);
      if (settled === NOT_READY || settled === FAILED) {
        waiting = next;
        break;
      }
      if (settled.done) {
        ended = settled;
        break;
      }
      batch.push(settled.value);
    }
    return batch;
  };
  const stream: AsyncGenerator<T> = {
    async next() {
      if (checked.length > 0) return { done: false, value: checked.shift() as T };
      if (ended) return ended;
      const batch = await held();
      if (batch.length === 0) return ended ?? { done: true, value: undefined };
      if (!(await stillAllowed(prisma, caller))) {
        ended = { done: true, value: undefined };
        // Not awaited: closing waits behind a read still in flight.
        void bestEffort("close a stream whose caller lost access", frames.return(undefined));
        throw new ORPCError("UNAUTHORIZED");
      }
      checked = batch.slice(1);
      return { done: false, value: batch[0] as T };
    },
    return: (value) => {
      checked = [];
      ended = { done: true, value };
      return frames.return(value);
    },
    throw: (error) => frames.throw(error),
    [Symbol.asyncIterator]: () => stream,
    [Symbol.asyncDispose]: async () => {
      await stream.return(undefined);
    },
  };
  return stream;
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
