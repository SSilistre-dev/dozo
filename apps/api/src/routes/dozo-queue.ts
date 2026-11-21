import { wakeRun } from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, ClientError, QUEUE_HOLDING_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  clearEndedRunState,
  createPendingSteeringRun,
  createThreadMessageInTransaction,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  transientRunEventsWhere,
} from "@rakazo/db";
import type { QueueRun, QueueSnapshot } from "../dozo-queue-plan.js";
import { planQueue, queueLabel } from "../dozo-queue-plan.js";
import { finishThreadStop, STOPPED_BY_MESSAGE_NOTE, stoppedRoutineNote } from "../thread-stop.js";
import { resolveThreadTarget } from "../thread-target.js";
import type { RouterContext } from "./context.js";

const RUN_FIELDS = {
  id: true,
  botId: true,
  userId: true,
  status: true,
  trigger: true,
  wakeAt: true,
  createdAt: true,
  threadId: true,
  sourceMessageId: true,
  routine: { select: { name: true } },
} as const;

function queueRun({
  routine,
  ...run
}: { routine: { name: string } | null } & Omit<QueueRun, "routineName">) {
  return { ...run, routineName: routine?.name ?? null };
}

/**
 * What waits for these bots, read in the caller's Space only. Names and words go only to the
 * person they belong to (`planQueue`); everything else here is ids, states and times.
 */
export async function loadDozoQueue(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  target: { threadId: string; botIds: string[] },
  now = new Date(),
) {
  const { spaceId } = actor;
  const botIds = { in: target.botIds };
  const [botRows, runRows, holdingRows, heldRows] = await Promise.all([
    prisma.bot.findMany({ where: { id: botIds, spaceId }, select: { id: true, computerId: true } }),
    prisma.run.findMany({
      where: { spaceId, botId: botIds, status: { in: ["queued", "leased", "running"] } },
      select: RUN_FIELDS,
    }),
    prisma.run.findMany({
      where: {
        spaceId,
        threadId: target.threadId,
        botId: botIds,
        status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
      },
      select: RUN_FIELDS,
    }),
    prisma.steeringMessage.findMany({
      where: {
        botId: botIds,
        runId: null,
        claimedAt: null,
        message: { threadId: target.threadId },
      },
      select: {
        botId: true,
        userId: true,
        message: { select: { id: true, seq: true, runId: true } },
      },
    }),
  ]);
  const bots = target.botIds.flatMap((id) => botRows.filter((bot) => bot.id === id));
  const computerIds = bots.flatMap((bot) => (bot.computerId ? [bot.computerId] : []));
  const leaseRows = computerIds.length
    ? await prisma.computerExecutionLease.findMany({
        where: { computerId: { in: computerIds }, expiresAt: { gt: now } },
        select: { computerId: true, botId: true, runId: true },
      })
    : [];
  const leaseRunRows = leaseRows.length
    ? await prisma.run.findMany({
        where: { spaceId, id: { in: leaseRows.map((lease) => lease.runId) } },
        select: RUN_FIELDS,
      })
    : [];
  // As the computer's own status reads a hold: an ended run's lease is a moment from release, a
  // run waiting for a takeover does not hold the computer, and a lease with no run is a boot.
  const leases = leaseRows.flatMap((lease): QueueSnapshot["leases"] => {
    const row = leaseRunRows.find((run) => run.id === lease.runId);
    if (!row) return [{ ...lease, run: null }];
    const active = (ACTIVE_RUN_STATUSES as readonly string[]).includes(row.status);
    return active && row.status !== "waiting_takeover" ? [{ ...lease, run: queueRun(row) }] : [];
  });

  const runs = runRows.map(queueRun);
  const held = heldRows.map((row) => ({
    messageId: row.message.id,
    botId: row.botId,
    userId: row.userId,
    seq: row.message.seq,
    runId: row.message.runId,
  }));
  // The caller's own words, from this conversation, for the caller's own work only.
  const ownMessageIds = [
    ...held.filter((message) => message.userId === actor.userId).map((m) => m.messageId),
    ...runs
      .filter((run) => run.userId === actor.userId && run.threadId === target.threadId)
      .flatMap((run) => (run.sourceMessageId ? [run.sourceMessageId] : [])),
  ];
  const messageRows = ownMessageIds.length
    ? await prisma.message.findMany({
        where: { id: { in: ownMessageIds }, threadId: target.threadId },
        select: { id: true, blocks: true },
      })
    : [];
  const previews = new Map<string, string>();
  for (const row of messageRows) {
    const text = storedMessageBlocks(row).find((block) => block.kind === "text")?.text;
    const label = text ? queueLabel(text) : null;
    if (label) previews.set(row.id, label);
  }

  return planQueue({
    actorUserId: actor.userId,
    threadId: target.threadId,
    now,
    bots,
    runs,
    holding: holdingRows.map(queueRun),
    leases,
    held,
    previews,
  });
}

const notFound = () => new ClientError("NOT_FOUND", "That is no longer waiting");

/**
 * Stop's note in the chat, written under the thread lock the caller holds: cancelling work that
 * was waiting says so the way Stop does, with the same words, and returns the event's seq for
 * `finishThreadStop` to tell the other clients about.
 */
async function writeStoppedNote(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "spaceId">,
  at: { threadId: string; botId: string },
  text: string,
) {
  const blocks: MessageBlock[] = [{ kind: "meta", text }];
  const message = await createThreadMessageInTransaction(tx, {
    threadId: at.threadId,
    role: "system",
    blocks,
    botId: at.botId,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: actor.spaceId,
    threadId: at.threadId,
    botId: at.botId,
    type: "thread.message.created",
    payload: { messageId: message.id, role: "system", blocks },
  });
  return event.seq;
}

export function dozoQueueRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  /**
   * Stop waiting for the caller's own queued run. This is not Stop: it ends one run that has
   * not started and nothing else, so another person's work, a run under way and the rest of the
   * conversation are left alone. The caller's follow-ups sent to it are dropped with it, and the
   * chat says so as Stop does (the routine's name for a routine's run). Messages that waited
   * behind it get a run of their own.
   */
  async function cancelRun(actor: Actor, runId: string) {
    const run = await deps.prisma.run.findFirst({
      where: { id: runId, spaceId: actor.spaceId, userId: actor.userId, status: "queued" },
      select: { threadId: true, botId: true, trigger: true, routine: { select: { name: true } } },
    });
    if (!run) throw notFound();
    const done = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      const cancelled = await tx.run.updateManyAndReturn({
        where: { id: runId, spaceId: actor.spaceId, userId: actor.userId, status: "queued" },
        data: { status: "cancelled", completedAt: new Date() },
        select: { id: true },
      });
      if (cancelled.length === 0) throw notFound();
      await clearEndedRunState(tx, [runId]);
      await tx.steeringMessage.deleteMany({ where: { runId } });
      await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        type: "run.cancelled",
        runId,
        payload: {},
      });
      await tx.event.deleteMany({ where: { ...transientRunEventsWhere(), runId } });
      const noteSeq = await writeStoppedNote(
        tx,
        actor,
        run,
        run.trigger === "routine" && run.routine
          ? stoppedRoutineNote(run.routine.name)
          : STOPPED_BY_MESSAGE_NOTE,
      );
      const continuationId = await createPendingSteeringRun(tx, {
        spaceId: actor.spaceId,
        threadId: run.threadId,
        botId: run.botId,
      });
      return { seq: noteSeq, continuationId };
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
    // A run that has not started holds no computer, so there is nothing to tear down.
    await finishThreadStop(deps, actor, run, {
      runIds: [runId],
      computers: [],
      leases: [],
      eventSeq: done.seq,
      stoppedHelpers: [],
    });
    if (done.continuationId) await wakeRun(deps.jobs, done.continuationId);
  }

  /**
   * Stop waiting for the caller's own message that is held behind a run. Like Stop it drops the
   * hold only: the message stays in the chat and, with nothing holding it, is read as history by
   * the next turn. The chat says so and the other clients are told, as for Stop.
   */
  async function cancelMessage(actor: Actor, messageId: string) {
    const message = await deps.prisma.message.findFirst({
      where: { id: messageId, thread: { spaceId: actor.spaceId } },
      select: { threadId: true },
    });
    if (!message) throw notFound();
    const holds = { messageId, userId: actor.userId, runId: null, claimedAt: null };
    const eventSeq = await deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${message.threadId} FOR UPDATE`;
      const [first] = await tx.steeringMessage.findMany({
        where: holds,
        select: { id: true, botId: true },
      });
      if (!first) throw notFound();
      await tx.steeringMessage.deleteMany({ where: holds });
      return writeStoppedNote(
        tx,
        actor,
        { threadId: message.threadId, botId: first.botId },
        STOPPED_BY_MESSAGE_NOTE,
      );
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
    await finishThreadStop(deps, actor, message, {
      runIds: [],
      computers: [],
      leases: [],
      eventSeq,
      stoppedHelpers: [],
    });
    // No run ended, so the line is announced here.
    await deps.events.publishSpaceChange?.(actor.spaceId, "runs");
  }

  return {
    dozoQueue: {
      list: authed.dozoQueue.list.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input);
        const botIds = target.kind === "bot" ? [target.botId] : target.memberBotIds;
        const items = await loadDozoQueue(deps.prisma, context.actor, {
          threadId: target.threadId,
          botIds,
        });
        return { items };
      }),
      cancelWaiting: authed.dozoQueue.cancelWaiting.handler(async ({ context, input }) => {
        if ("runId" in input) await cancelRun(context.actor, input.runId);
        else await cancelMessage(context.actor, input.messageId);
        return { cancelled: true as const };
      }),
    },
  };
}
