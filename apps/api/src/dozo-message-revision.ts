import { listPiCatalog, wakeRun } from "@rakazo/adapters";
import type { Actor, DozoRevisable, DozoRevisionConfirmed, MessageBlock } from "@rakazo/contracts";
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
  readBackupReplies,
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

type Db = Pick<
  Prisma.TransactionClient,
  "message" | "run" | "event" | "externalEffect" | "$queryRaw"
>;

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MESSAGE_EVENT_TYPES = ["thread.message.created", "thread.message.updated"];
/**
 * The events of a run that only talked. Any other type, one added later included, may mean the run
 * did something outside the chat, so its turn cannot be undone. A test holds every known type to
 * one side or the other.
 */
export const QUIET_EVENT_TYPES = [
  "thread.message.created",
  "thread.message.updated",
  "thread.progress",
  "thread.meta",
  "run.started",
  "run.steering.claimed",
  "run.checkpointed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "usage.recorded",
  "computer.status",
  "heartbeat",
];
/** How many of the newest person turns can change; older ones are past what a chat shows first. */
export const REVISION_TURNS = 25;

type Said = {
  id: string;
  /** Only words: no file, picture, card or anything else a removal would leave behind. */
  textOnly: boolean;
  /** Another member pinned it: their own record, which a rewind must not take. */
  pinnedByOthers: boolean;
  /** The caller pinned it. */
  pinnedByCaller: boolean;
};

/** One person turn of a direct chat and everything that answered it. */
export interface RevisionTurn {
  message: Said & {
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
  replies: Array<Said & { role: string; runId: string | null }>;
  /** Those runs that may have acted outside the chat. */
  actions: number;
}

/** A chat's newest person turns, newest first. */
export interface RevisionHistory {
  /** Messages up to here are in the compaction summary and can no longer change. */
  compactedUpToSeq: number | null;
  /** Any run of the chat still working or waiting. */
  busy: boolean;
  /**
   * The Space's memory learns from each finished turn and can only forget a whole chat, so a turn
   * it may hold cannot be taken back.
   */
  learnsTurns: boolean;
  turns: RevisionTurn[];
  /** The chat's newest message: the last a change removes when it removes any. */
  lastMessageId: string | null;
}

export interface RevisionTarget {
  kind: Revision["kind"];
  messageId: string;
  turn: RevisionTurn;
  run: RevisionTurn["runs"][number];
  /** Going back to it also removes later turns, which the person confirms first. */
  earlier: boolean;
  /** How many messages the change removes. */
  removes: number;
}

/**
 * Which messages can change: the caller's own messages (Edit) and the bot's reply that ends each
 * of their turns (Regenerate), going back from the newest turn. Changing one removes everything
 * after its message, so every turn from there on must be wholly the caller's and the bot's own
 * conversation: their own words from the app (not a chat app, which already holds the reply, and
 * not a spoken call), outside the compaction summary, answered in words only by finished runs of
 * their own that did nothing outside the chat, with nothing another member pinned. The first turn
 * that is not stops the walk. A message of theirs that started no run and got no reply (a
 * reaction) goes with a rewind but offers nothing.
 */
export function planRevision(history: RevisionHistory | null, userId: string): RevisionTarget[] {
  if (!history || history.busy || history.learnsTurns) return [];
  const targets: RevisionTarget[] = [];
  let later = 0;
  for (const [index, turn] of history.turns.entries()) {
    if (!quietTurn(turn, history.compactedUpToSeq, userId)) break;
    const run = turn.runs[0];
    const { message, replies } = turn;
    const removes = later + replies.length;
    const earlier = index > 0;
    if (run && message.blocks.length > 0 && message.textOnly)
      targets.push({ kind: "edit", messageId: message.id, turn, run, earlier, removes });
    const reply = replies.at(-1);
    if (run && reply)
      targets.push({ kind: "regenerate", messageId: reply.id, turn, run, earlier, removes });
    // Going further back removes this message too.
    if (!message.textOnly || message.pinnedByOthers) break;
    later = removes + 1;
  }
  return targets;
}

/**
 * The revisable answer with the chat's replies a backup wrote, each named by the model's name in
 * the catalog, else its id.
 */
export function withBackupReplies(
  revisable: DozoRevisable,
  replies: ReadonlyArray<{ messageId: string; provider: string; modelId: string }>,
): DozoRevisable {
  if (!replies.length) return revisable;
  const catalog = listPiCatalog();
  const name = (provider: string, modelId: string) =>
    catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label ?? modelId;
  return {
    ...revisable,
    backupReplies: Object.fromEntries(
      replies.map((reply) => [reply.messageId, name(reply.provider, reply.modelId)]),
    ),
  };
}

/**
 * The newest turn's messages in the two fields every client reads, older ones only when any, and
 * for every message named what changing it removes, which the client sends back as confirmed.
 */
export function revisableOf(
  targets: readonly RevisionTarget[],
  lastMessageId: string | null,
): DozoRevisable {
  const newest = (kind: Revision["kind"]) =>
    targets.find((target) => target.kind === kind && !target.earlier)?.messageId ?? null;
  const older = targets.filter((target) => target.earlier);
  const ids = (kind: Revision["kind"]) =>
    older.filter((target) => target.kind === kind).map((target) => target.messageId);
  const revisable: DozoRevisable = {
    editMessageId: newest("edit"),
    regenerateMessageId: newest("regenerate"),
  };
  if (targets.length === 0) return revisable;
  const edit = ids("edit");
  const regenerate = ids("regenerate");
  return {
    ...revisable,
    ...(edit.length > 0 ? { earlierEditMessageIds: edit } : {}),
    ...(regenerate.length > 0 ? { earlierRegenerateMessageIds: regenerate } : {}),
    removedCounts: Object.fromEntries(targets.map((target) => [target.messageId, target.removes])),
    lastMessageId,
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
  return replies.every(
    (reply) =>
      reply.role === "bot" &&
      run !== undefined &&
      reply.runId === run.id &&
      reply.textOnly &&
      !reply.pinnedByOthers,
  );
}

/**
 * Reads the newest turns inside a transaction: whose pins they carry is read past the rule that
 * shows each member only their own.
 */
export async function loadRevisionHistory(
  db: Db,
  thread: { id: string; historyCompactedUpToSeq: number | null },
  caller: { userId: string; learnsTurns: boolean },
): Promise<RevisionHistory> {
  const asks = await db.message.findMany({
    where: { threadId: thread.id, role: "user" },
    orderBy: { seq: "desc" },
    take: REVISION_TURNS,
    select: { id: true, seq: true, authorUserId: true, clientNonce: true, blocks: true },
  });
  const oldest = asks.at(-1);
  const base = {
    compactedUpToSeq: thread.historyCompactedUpToSeq,
    learnsTurns: caller.learnsTurns,
  };
  if (!oldest) return { ...base, busy: false, turns: [], lastMessageId: null };
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
      where: { threadId: thread.id, seq: { gt: oldest.seq }, role: { not: "user" } },
      orderBy: { seq: "asc" },
      select: { id: true, seq: true, role: true, runId: true, blocks: true },
    }),
    db.run.count({ where: { threadId: thread.id, status: { in: [...ACTIVE_RUN_STATUSES] } } }),
  ]);
  const runId = { in: runs.map((run) => run.id) };
  const messageIds = [...asks, ...after].map((message) => message.id);
  const [events, effects, pins] = await Promise.all([
    db.event.findMany({
      where: { runId, type: { notIn: QUIET_EVENT_TYPES } },
      select: { runId: true },
      distinct: ["runId"],
    }),
    db.externalEffect.findMany({ where: { runId }, select: { runId: true }, distinct: ["runId"] }),
    runAsSystemInTransaction(
      db,
      "pins a rewind would remove, every member's",
      () =>
        db.$queryRaw<Array<{ messageId: string; userId: string }>>`
        SELECT "messageId", "userId" FROM dozo_message_pins
        WHERE "threadId" = ${thread.id} AND "messageId" = ANY(${messageIds})`,
    ),
  ]);
  const acting = new Set([...events, ...effects].map((row) => row.runId));
  const said = (message: { id: string; blocks: unknown }) => {
    const { blocks, intact } = readMessageBlocks(message);
    const pinnedBy = pins.filter((pin) => pin.messageId === message.id).map((pin) => pin.userId);
    return {
      blocks,
      intact,
      textOnly: intact && blocks.every((block) => block.kind === "text"),
      pinnedByOthers: pinnedBy.some((user) => user !== caller.userId),
      pinnedByCaller: pinnedBy.includes(caller.userId),
    };
  };
  const turns = asks.map((ask, index): RevisionTurn => {
    const next = asks[index - 1]?.seq ?? Number.POSITIVE_INFINITY;
    const own = runs.filter((run) => run.sourceMessageId === ask.id);
    return {
      message: { ...ask, ...said(ask) },
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
        .map(({ id, role, runId, blocks }) => {
          const { textOnly, pinnedByOthers, pinnedByCaller } = said({ id, blocks });
          return { id, role, runId, textOnly, pinnedByOthers, pinnedByCaller };
        }),
      actions: own.filter((run) => acting.has(run.id)).length,
    };
  });
  const newest = turns[0];
  const lastMessageId = newest ? (newest.replies.at(-1)?.id ?? newest.message.id) : null;
  return { ...base, busy: busy > 0, turns, lastMessageId };
}

export class MessageNotRevisableError extends ClientError {
  constructor() {
    super("CONFLICT", "This message can no longer be changed.", "MESSAGE_NOT_REVISABLE");
  }
}

type Revision = { kind: "edit"; text: string } | { kind: "regenerate" };
/** What the person confirmed would go: how many messages, and the newest of them. */
type Confirmed = DozoRevisionConfirmed | undefined;

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

  /**
   * Whether the Space's memory learns from each finished turn: then no turn can be taken back. A
   * provider that cannot be read counts as learning, so nothing is offered rather than an error.
   */
  async function learnsTurns(spaceId: string) {
    const configured = await bestEffort(
      "message revision memory provider",
      deps.memoryProviders.resolve(spaceId),
    );
    return configured === undefined || Boolean(configured?.provider.retainConversation);
  }

  async function revise(
    actor: Actor,
    threadId: string,
    messageId: string,
    revision: Revision,
    confirmed: Confirmed,
  ) {
    const { botId } = await directThread(actor, threadId);
    const learns = await learnsTurns(actor.spaceId);
    const setup = await modelSetup(deps, actor);
    if (setup.needsModel && !(await botsRunOwnModels(deps, actor, [botId])))
      throw new ClientError("BAD_REQUEST", MODEL_REQUIRED_SEND_ERROR);
    await assertTeachingSendAllowed(deps.prisma, actor.spaceId, botId);
    const committed = await deps.prisma.$transaction(
      (tx) =>
        reviseInTransaction(tx, {
          actor,
          threadId,
          botId,
          messageId,
          revision,
          confirmed,
          learnsTurns: learns,
        }),
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
        const { userId, spaceId } = context.actor;
        const caller = { userId, learnsTurns: await learnsTurns(spaceId) };
        const history = await deps.prisma.$transaction((tx) =>
          loadRevisionHistory(tx, thread, caller),
        );
        return withBackupReplies(
          revisableOf(planRevision(history, userId), history.lastMessageId),
          await readBackupReplies(deps.prisma, thread.id, userId),
        );
      }),
      edit: authed.dozoMessages.edit.handler(({ context, input }) =>
        revise(
          context.actor,
          input.threadId,
          input.messageId,
          { kind: "edit", text: input.text },
          input.confirmed,
        ),
      ),
      regenerate: authed.dozoMessages.regenerate.handler(({ context, input }) =>
        revise(
          context.actor,
          input.threadId,
          input.messageId,
          { kind: "regenerate" },
          input.confirmed,
        ),
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
    confirmed: Confirmed;
    learnsTurns: boolean;
  },
): Promise<{ runId: string; seq: number; pinnedBy: string[] }> {
  const { actor, threadId, botId, revision } = input;
  if (!(await spaceTakesWork(tx, actor.spaceId))) throw new MessageNotRevisableError();
  const thread = await tx.thread.update({
    where: { id: threadId },
    data: { nextMessageSeq: { increment: 0 } },
    select: {
      id: true,
      nextMessageSeq: true,
      historyCompactedUpToSeq: true,
      historyCompactionRetryAfterSeq: true,
    },
  });
  const caller = { userId: actor.userId, learnsTurns: input.learnsTurns };
  const history = await loadRevisionHistory(tx, thread, caller);
  const target = planRevision(history, actor.userId).find(
    (each) => each.kind === revision.kind && each.messageId === input.messageId,
  );
  if (!target) throw new MessageNotRevisableError();
  const { message } = target.turn;
  // The turns are newest first: every message after this one, oldest first.
  const removed = history.turns
    .slice(0, history.turns.indexOf(target.turn) + 1)
    .reverse()
    .flatMap((turn) => (turn === target.turn ? turn.replies : [turn.message, ...turn.replies]));
  const removedIds = removed.map((each) => each.id);
  // Exactly what the person confirmed, read before anything new arrived: a turn that came and
  // finished meanwhile would go too. A client that sends nothing confirmed only its newest turn.
  const { confirmed } = input;
  const ok = confirmed
    ? confirmed.removes === removed.length &&
      confirmed.lastMessageId === (removed.at(-1)?.id ?? null)
    : !target.earlier;
  if (!ok) throw new MessageNotRevisableError();
  if (removedIds.length > 0) {
    // Hold what goes, so no pin can land on it before the delete, then read every member's pins
    // on it again: another member's pin added since the plan stops the change.
    await tx.$queryRaw`SELECT "id" FROM messages WHERE "id" = ANY(${removedIds}) FOR UPDATE`;
    const pins = await runAsSystemInTransaction(
      tx,
      "pins on what a rewind removes",
      () =>
        tx.$queryRaw<Array<{ userId: string }>>`
        SELECT "userId" FROM dozo_message_pins WHERE "messageId" = ANY(${removedIds})`,
    );
    if (pins.some((pin) => pin.userId !== actor.userId)) throw new MessageNotRevisableError();
  }
  // What was removed is the thread's tail, so the next message takes the first freed seq: the
  // history stays gapless (compaction and paging stop at a gap) and the new reply reads as unread
  // again. Compaction has not reached it (planRevision refuses a message in its summary), and the
  // rewind count makes a summary begun before now, over messages that are gone, land nowhere. A
  // summary that was too long waits for as many new messages as it did before.
  const nextMessageSeq = message.seq + 1;
  const retry = thread.historyCompactionRetryAfterSeq;
  await tx.thread.update({
    where: { id: threadId },
    data: {
      nextMessageSeq,
      dozoRewinds: { increment: 1 },
      historyCompactionRetryAfterSeq:
        retry === null ? null : retry - (thread.nextMessageSeq - nextMessageSeq),
    },
  });
  await tx.threadRead.updateMany({
    where: { threadId, lastReadSeq: { gt: message.seq } },
    data: { lastReadSeq: message.seq },
  });
  // Only the caller's own pins can be on what goes: they read their pins again.
  const pinnedBy = removed.some((each) => each.pinnedByCaller) ? [actor.userId] : [];
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
