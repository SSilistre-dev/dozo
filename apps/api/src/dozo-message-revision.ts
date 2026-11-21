import { wakeRun } from "@rakazo/adapters";
import type { Actor, DozoRevisable, MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  ClientError,
  callIdFromClientNonce,
  MODEL_REQUIRED_SEND_ERROR,
  messagingChannelId,
} from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import {
  appendEventInTransaction,
  IsolationError,
  loadMessageAuthor,
  readMessageBlocks,
  runAsSystemInTransaction,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withDozoChatBot,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { buildSendPrompt } from "./artifacts.js";
import { dozoMessagePinRoutes } from "./dozo-message-pins.js";
import type { RouterContext } from "./routes/context.js";
import { botsRunOwnModels, modelSetup } from "./routes/shared.js";
import { assertTeachingSendAllowed } from "./taught-skills.js";
import { resolveThreadTarget } from "./thread-target.js";

type Db = Pick<Prisma.TransactionClient, "message" | "run" | "event" | "externalEffect">;

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MESSAGE_EVENT_TYPES = ["thread.message.created", "thread.message.updated"];
/**
 * What a run records when it did something outside the chat: a tool call (upstream's own test
 * before it retries a routine run), and the records a run writes without one.
 */
const ACTION_EVENT_TYPES = [
  "agent.tool.called",
  "memory.revised",
  "routine.created",
  "routine.updated",
  "effect.recorded",
  "skill.draft.created",
  "thread.subagent",
  "command.finished",
];
/** How many of the newest person turns can change; older ones are past what a chat shows first. */
export const REVISION_TURNS = 25;

/** One person turn of a direct chat and everything that answered it. */
export interface RevisionTurn {
  message: {
    id: string;
    seq: number;
    authorUserId: string | null;
    clientNonce: string | null;
    blocks: MessageBlock[];
    intact: boolean;
  };
  /** The runs started from that message, newest first: earlier ones were edited or regenerated. */
  runs: Array<{
    id: string;
    taskPrompt: string;
    status: string;
    trigger: string;
    userId: string;
    mirrored: boolean;
  }>;
  /** The messages after it up to the next person turn, oldest first. */
  replies: Array<{ id: string; role: string; runId: string | null }>;
  /** Those runs that acted outside the chat. */
  actions: number;
}

/** A chat's newest person turns, newest first. */
export interface RevisionHistory {
  /** Messages up to here are in the compaction summary and can no longer change. */
  compactedUpToSeq: number | null;
  /** Any run of the chat still working or waiting. */
  busy: boolean;
  turns: RevisionTurn[];
}

export interface RevisionTarget {
  kind: Revision["kind"];
  messageId: string;
  turn: RevisionTurn;
  run: RevisionTurn["runs"][number];
  /** Going back to it also removes later turns, which the person confirms first. */
  earlier: boolean;
}

/**
 * Which messages can change: the caller's own messages (Edit) and the bot's reply that ends each
 * of their turns (Regenerate), going back from the newest turn. Changing one removes everything
 * after its message, so every turn from there on must be wholly the caller's and the bot's own
 * conversation: their own message from the app (not a chat app, which already holds the reply,
 * and not a spoken call), outside the compaction summary, answered only by finished runs of their
 * own that did nothing outside the chat. The first turn that is not stops the walk. A message of
 * theirs that started no run and got no reply (a reaction) goes with a rewind but offers nothing.
 */
export function planRevision(history: RevisionHistory | null, userId: string): RevisionTarget[] {
  if (!history || history.busy) return [];
  const targets: RevisionTarget[] = [];
  for (const [index, turn] of history.turns.entries()) {
    if (!quietTurn(turn, history.compactedUpToSeq, userId)) break;
    const run = turn.runs[0];
    if (!run) continue;
    const { message } = turn;
    const earlier = index > 0;
    if (message.blocks.length > 0 && message.blocks.every((block) => block.kind === "text"))
      targets.push({ kind: "edit", messageId: message.id, turn, run, earlier });
    const reply = turn.replies.at(-1);
    if (reply) targets.push({ kind: "regenerate", messageId: reply.id, turn, run, earlier });
  }
  return targets;
}

/** The newest turn's messages in the two fields every client reads, older ones only when any. */
export function revisableOf(targets: readonly RevisionTarget[]): DozoRevisable {
  const newest = (kind: Revision["kind"]) =>
    targets.find((target) => target.kind === kind && !target.earlier)?.messageId ?? null;
  const earlier = (kind: Revision["kind"]) =>
    targets.filter((target) => target.kind === kind && target.earlier).map((t) => t.messageId);
  const editEarlier = earlier("edit");
  const regenerateEarlier = earlier("regenerate");
  return {
    editMessageId: newest("edit"),
    regenerateMessageId: newest("regenerate"),
    ...(editEarlier.length > 0 ? { earlierEditMessageIds: editEarlier } : {}),
    ...(regenerateEarlier.length > 0 ? { earlierRegenerateMessageIds: regenerateEarlier } : {}),
  };
}

function quietTurn(turn: RevisionTurn, compactedUpToSeq: number | null, userId: string): boolean {
  const { message, runs, replies } = turn;
  if (message.authorUserId !== userId || turn.actions > 0) return false;
  if (
    !message.intact ||
    messagingChannelId(message.blocks) ||
    callIdFromClientNonce(message.clientNonce)
  )
    return false;
  if (compactedUpToSeq !== null && message.seq <= compactedUpToSeq) return false;
  const ownRun = (run: RevisionTurn["runs"][number]) =>
    run.userId === userId &&
    run.trigger === "user" &&
    !run.mirrored &&
    TERMINAL_RUN_STATUSES.has(run.status);
  if (!runs.every(ownRun)) return false;
  // The newest run wrote every reply; earlier runs are the ones an edit or regenerate replaced.
  const run = runs[0];
  return replies.every((reply) => reply.role === "bot" && run && reply.runId === run.id);
}

export async function loadRevisionHistory(
  db: Db,
  thread: { id: string; historyCompactedUpToSeq: number | null },
): Promise<RevisionHistory> {
  const asks = await db.message.findMany({
    where: { threadId: thread.id, role: "user" },
    orderBy: { seq: "desc" },
    take: REVISION_TURNS,
    select: { id: true, seq: true, authorUserId: true, clientNonce: true, blocks: true },
  });
  const oldest = asks.at(-1);
  const compactedUpToSeq = thread.historyCompactedUpToSeq;
  if (!oldest) return { compactedUpToSeq, busy: false, turns: [] };
  const [runs, after, busy] = await Promise.all([
    db.run.findMany({
      where: { threadId: thread.id, sourceMessageId: { in: asks.map((ask) => ask.id) } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        sourceMessageId: true,
        status: true,
        trigger: true,
        userId: true,
        messagingMirroredAt: true,
        task: { select: { prompt: true } },
      },
    }),
    db.message.findMany({
      where: { threadId: thread.id, seq: { gt: oldest.seq } },
      orderBy: { seq: "asc" },
      select: { id: true, seq: true, role: true, runId: true },
    }),
    db.run.count({ where: { threadId: thread.id, status: { in: [...ACTIVE_RUN_STATUSES] } } }),
  ]);
  const runId = { in: runs.map((run) => run.id) };
  const [events, effects] = await Promise.all([
    db.event.findMany({
      where: { runId, type: { in: ACTION_EVENT_TYPES } },
      select: { runId: true },
      distinct: ["runId"],
    }),
    db.externalEffect.findMany({ where: { runId }, select: { runId: true }, distinct: ["runId"] }),
  ]);
  const acting = new Set([...events, ...effects].map((row) => row.runId));
  const turns = asks.map((ask, index): RevisionTurn => {
    const next = asks[index - 1]?.seq ?? Number.POSITIVE_INFINITY;
    const own = runs.filter((run) => run.sourceMessageId === ask.id);
    const { blocks, intact } = readMessageBlocks(ask);
    return {
      message: { ...ask, blocks, intact },
      runs: own.map((run) => ({
        id: run.id,
        taskPrompt: run.task.prompt,
        status: run.status,
        trigger: run.trigger,
        userId: run.userId,
        mirrored: run.messagingMirroredAt !== null,
      })),
      replies: after
        .filter((message) => message.seq > ask.seq && message.seq < next)
        .map(({ id, role, runId }) => ({ id, role, runId })),
      actions: own.filter((run) => acting.has(run.id)).length,
    };
  });
  return { compactedUpToSeq, busy: busy > 0, turns };
}

export class MessageNotRevisableError extends ClientError {
  constructor() {
    super("CONFLICT", "This message can no longer be changed.", "MESSAGE_NOT_REVISABLE");
  }
}

type Revision = { kind: "edit"; text: string } | { kind: "regenerate" };

export function dozoMessagesRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  /** A direct chat with a bot they can reach, main or extra; group and helper chats are not. */
  async function directThread(actor: Actor, threadId: string) {
    const thread = await withDozoChatBot(
      deps.prisma,
      threadId,
      await deps.prisma.thread.findFirst({
        where: { id: threadId, spaceId: actor.spaceId },
        select: { id: true, botId: true, groupId: true, historyCompactedUpToSeq: true },
      }),
    );
    if (!thread?.botId) throw new IsolationError();
    // The bot's own visibility rules decide who may reach its chat, main or extra.
    const target = await resolveThreadTarget(deps.prisma, actor, {
      chatBotId: thread.botId,
      chatId: threadId,
    });
    if (target.threadId !== threadId) throw new IsolationError();
    return { ...thread, botId: thread.botId };
  }

  async function revise(actor: Actor, threadId: string, messageId: string, revision: Revision) {
    const { botId } = await directThread(actor, threadId);
    const setup = await modelSetup(deps, actor);
    if (setup.needsModel && !(await botsRunOwnModels(deps, actor, [botId])))
      throw new ClientError("BAD_REQUEST", MODEL_REQUIRED_SEND_ERROR);
    await assertTeachingSendAllowed(deps.prisma, actor.spaceId, botId);
    const committed = await deps.prisma.$transaction(
      (tx) => reviseInTransaction(tx, { actor, threadId, botId, messageId, revision }),
      THREAD_LOCK_TRANSACTION_OPTIONS,
    );
    // Committed: a missed signal must not report the change as failed or leave the run asleep.
    await wakeRun(deps.jobs, committed.runId);
    if (committed.pinnedBy.length > 0)
      await bestEffort(
        "message revision pins signal",
        deps.events.publishRosterChange?.({ userIds: committed.pinnedBy }),
      );
    await bestEffort("message revision signal", deps.events.notify(threadId, committed.seq));
    await bestEffort(
      "message revision runs signal",
      deps.events.publishSpaceChange?.(actor.spaceId, "runs"),
    );
    return { runId: committed.runId };
  }

  return {
    dozoMessages: {
      revisable: authed.dozoMessages.revisable.handler(async ({ context, input }) => {
        const thread = await directThread(context.actor, input.threadId);
        const history = await loadRevisionHistory(deps.prisma, thread);
        return revisableOf(planRevision(history, context.actor.userId));
      }),
      edit: authed.dozoMessages.edit.handler(({ context, input }) =>
        revise(context.actor, input.threadId, input.messageId, { kind: "edit", text: input.text }),
      ),
      regenerate: authed.dozoMessages.regenerate.handler(({ context, input }) =>
        revise(context.actor, input.threadId, input.messageId, { kind: "regenerate" }),
      ),
      ...dozoMessagePinRoutes(ctx),
    },
  };
}

/**
 * Under the thread's row lock, as every message writer takes it, so no send, reply or clear lands
 * between the check and the change. Everything after the message goes, the replies to it and any
 * later turns, with their events, so their words stay nowhere in the chat; the old runs stay for
 * usage and history. A new run starts from the same message, as a send would.
 */
export async function reviseInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    actor: Actor;
    threadId: string;
    botId: string;
    messageId: string;
    revision: Revision;
  },
): Promise<{ runId: string; seq: number; pinnedBy: string[] }> {
  const { actor, threadId, botId, revision } = input;
  if (!(await spaceTakesWork(tx, actor.spaceId))) throw new MessageNotRevisableError();
  const thread = await tx.thread.update({
    where: { id: threadId },
    data: { nextMessageSeq: { increment: 0 } },
    select: { id: true, historyCompactedUpToSeq: true },
  });
  const history = await loadRevisionHistory(tx, thread);
  const target = planRevision(history, actor.userId).find(
    (each) => each.kind === revision.kind && each.messageId === input.messageId,
  );
  if (!target) throw new MessageNotRevisableError();
  const { message } = target.turn;
  // The turns are newest first: every message after this one, oldest first.
  const removedIds = history.turns
    .slice(0, history.turns.indexOf(target.turn) + 1)
    .reverse()
    .flatMap((turn) =>
      turn === target.turn ? turn.replies : [{ id: turn.message.id }, ...turn.replies],
    )
    .map((each) => each.id);
  // What was removed is the thread's tail, so the next message takes the first freed seq: the
  // history stays gapless (compaction and paging stop at a gap) and the new reply reads as unread
  // again. Compaction has not reached it: planRevision refuses a message in its summary.
  await tx.thread.update({ where: { id: threadId }, data: { nextMessageSeq: message.seq + 1 } });
  await tx.threadRead.updateMany({
    where: { threadId, lastReadSeq: { gt: message.seq } },
    data: { lastReadSeq: message.seq },
  });
  // Pins go with their messages; the members who had one read their pins again. A member sees
  // only their own pins, so the others' are read past that rule.
  const pinnedBy =
    removedIds.length === 0
      ? []
      : (
          await runAsSystemInTransaction(
            tx,
            "members whose pins a rewind removes",
            () =>
              tx.$queryRaw<{ userId: string }[]>`
            SELECT DISTINCT "userId" FROM dozo_message_pins
            WHERE "threadId" = ${threadId} AND "messageId" = ANY(${removedIds})`,
          )
        ).map((row) => row.userId);
  const revisedIds = revision.kind === "edit" ? [message.id, ...removedIds] : removedIds;
  await tx.message.deleteMany({ where: { id: { in: removedIds } } });
  await tx.event.deleteMany({
    where: {
      threadId,
      type: { in: MESSAGE_EVENT_TYPES },
      OR: revisedIds.map((id) => ({ payload: { path: ["messageId"], equals: id } })),
    },
  });
  let seq = -1;
  const append = async (payload: Record<string, unknown>) => {
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId,
      botId,
      type: "thread.message.updated",
      payload,
    });
    seq = event.seq;
  };
  // Clients drop a removed message at once; one that does not know the flag reads it again later.
  for (const id of removedIds) await append({ messageId: id, removed: true });
  if (revision.kind === "edit") {
    const blocks: MessageBlock[] = [{ kind: "text", text: revision.text }];
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    // The old run's message events went above, the message's own among them: this one replaces it.
    await append({
      messageId: message.id,
      role: "user",
      seq: message.seq,
      blocks,
      author: await loadMessageAuthor(tx, actor.userId),
    });
  }
  const task = await tx.task.create({
    data: {
      spaceId: actor.spaceId,
      botId,
      threadId,
      userId: actor.userId,
      prompt: revision.kind === "edit" ? buildSendPrompt(revision.text, []) : target.run.taskPrompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: actor.spaceId,
      botId,
      threadId,
      taskId: task.id,
      userId: actor.userId,
      status: "queued",
      trigger: "user",
      sourceMessageId: message.id,
    },
  });
  // A message sent from the app points at the run that answers it.
  await tx.message.updateMany({
    where: { id: message.id, runId: target.run.id },
    data: { runId: run.id },
  });
  return { runId: run.id, seq, pinnedBy };
}
