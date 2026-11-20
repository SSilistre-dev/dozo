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
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
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

/** The newest person turn of a direct chat and everything that answered it. */
export interface RevisionTurn {
  /** Messages up to here are in the compaction summary and can no longer change. */
  compactedUpToSeq: number | null;
  /** Any run of the chat still working or waiting. */
  busy: boolean;
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
  /** Every message after it, oldest first. */
  replies: Array<{ id: string; role: string; runId: string | null }>;
  /** Tool calls and recorded external effects of those runs. */
  actions: number;
}

export interface RevisionPlan {
  run: RevisionTurn["runs"][number];
  revisable: DozoRevisable;
}

/**
 * What can change in the newest turn, if anything. Only a turn that is wholly the caller's and the
 * bot's own conversation can: their own message from the app (not a chat app, which already holds
 * the reply, and not a spoken call), answered by finished runs that called no tool, so going back
 * undoes nothing outside the chat. The newest run wrote every reply after it; earlier runs are
 * the ones an edit or regenerate replaced. Regenerating also needs a reply to replace.
 */
export function planRevision(turn: RevisionTurn | null, userId: string): RevisionPlan | null {
  const run = turn?.runs[0];
  if (!turn || !run || turn.busy || turn.actions > 0) return null;
  const { message, replies } = turn;
  if (message.authorUserId !== userId) return null;
  const ownTurn = (each: RevisionTurn["runs"][number]) =>
    each.userId === userId &&
    each.trigger === "user" &&
    !each.mirrored &&
    TERMINAL_RUN_STATUSES.has(each.status);
  if (!turn.runs.every(ownTurn)) return null;
  if (
    !message.intact ||
    messagingChannelId(message.blocks) ||
    callIdFromClientNonce(message.clientNonce)
  )
    return null;
  if (turn.compactedUpToSeq !== null && message.seq <= turn.compactedUpToSeq) return null;
  if (replies.some((reply) => reply.role !== "bot" || reply.runId !== run.id)) return null;
  const textOnly = message.blocks.length > 0 && message.blocks.every((b) => b.kind === "text");
  return {
    run,
    revisable: {
      editMessageId: textOnly ? message.id : null,
      regenerateMessageId: replies.at(-1)?.id ?? null,
    },
  };
}

export async function loadRevisionTurn(
  db: Db,
  thread: { id: string; historyCompactedUpToSeq: number | null },
): Promise<RevisionTurn | null> {
  const message = await db.message.findFirst({
    where: { threadId: thread.id, role: "user" },
    orderBy: { seq: "desc" },
    select: { id: true, seq: true, authorUserId: true, clientNonce: true, blocks: true },
  });
  if (!message) return null;
  const [runs, replies, busy] = await Promise.all([
    db.run.findMany({
      where: { threadId: thread.id, sourceMessageId: message.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        trigger: true,
        userId: true,
        messagingMirroredAt: true,
        task: { select: { prompt: true } },
      },
    }),
    db.message.findMany({
      where: { threadId: thread.id, seq: { gt: message.seq } },
      orderBy: { seq: "asc" },
      select: { id: true, role: true, runId: true },
    }),
    db.run.count({ where: { threadId: thread.id, status: { in: [...ACTIVE_RUN_STATUSES] } } }),
  ]);
  // The same test upstream uses before it retries a routine run on its own.
  const runId = { in: runs.map((run) => run.id) };
  const [toolCalls, effects] = await Promise.all([
    db.event.count({ where: { runId, type: "agent.tool.called" } }),
    db.externalEffect.count({ where: { runId } }),
  ]);
  const { blocks, intact } = readMessageBlocks(message);
  return {
    compactedUpToSeq: thread.historyCompactedUpToSeq,
    busy: busy > 0,
    message: { ...message, blocks, intact },
    runs: runs.map((run) => ({
      id: run.id,
      taskPrompt: run.task.prompt,
      status: run.status,
      trigger: run.trigger,
      userId: run.userId,
      mirrored: run.messagingMirroredAt !== null,
    })),
    replies,
    actions: toolCalls + effects,
  };
}

export class MessageNotRevisableError extends ClientError {
  constructor() {
    super("CONFLICT", "This message can no longer be changed.", "MESSAGE_NOT_REVISABLE");
  }
}

type Revision = { kind: "edit"; text: string } | { kind: "regenerate" };

export function dozoMessagesRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;

  /** The caller's direct chat with a bot they can reach; group and helper chats are not. */
  async function directThread(actor: Actor, threadId: string) {
    const thread = await deps.prisma.thread.findFirst({
      where: { id: threadId, spaceId: actor.spaceId },
      select: { id: true, botId: true, historyCompactedUpToSeq: true },
    });
    if (!thread?.botId) throw new IsolationError();
    // The bot's own visibility rules decide who may reach its chat.
    const target = await resolveThreadTarget(deps.prisma, actor, { botId: thread.botId });
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
        const turn = await loadRevisionTurn(deps.prisma, thread);
        return (
          planRevision(turn, context.actor.userId)?.revisable ?? {
            editMessageId: null,
            regenerateMessageId: null,
          }
        );
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
 * between the check and the change. The old reply's messages and their events go, so its words
 * stay nowhere in the chat; the old run stays for usage and history. A new run starts from the
 * same message, as a send would.
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
): Promise<{ runId: string; seq: number }> {
  const { actor, threadId, botId, revision } = input;
  if (!(await spaceTakesWork(tx, actor.spaceId))) throw new MessageNotRevisableError();
  const thread = await tx.thread.update({
    where: { id: threadId },
    data: { nextMessageSeq: { increment: 0 } },
    select: { id: true, historyCompactedUpToSeq: true },
  });
  const turn = await loadRevisionTurn(tx, thread);
  const plan = planRevision(turn, actor.userId);
  const allowed =
    revision.kind === "edit" ? plan?.revisable.editMessageId : plan?.revisable.regenerateMessageId;
  if (!turn || !plan || allowed !== input.messageId) throw new MessageNotRevisableError();
  const { message, replies } = turn;
  const replyIds = replies.map((reply) => reply.id);
  // The replies are the thread's tail, so the next message takes the first freed seq: the history
  // stays gapless (compaction and paging stop at a gap) and the new reply reads as unread again.
  // Compaction never reaches the newest turn (it keeps the last HISTORY_WINDOW_SIZE messages).
  await tx.thread.update({ where: { id: threadId }, data: { nextMessageSeq: message.seq + 1 } });
  await tx.threadRead.updateMany({
    where: { threadId, lastReadSeq: { gt: message.seq } },
    data: { lastReadSeq: message.seq },
  });
  const revisedIds = revision.kind === "edit" ? [message.id, ...replyIds] : replyIds;
  await tx.message.deleteMany({ where: { id: { in: replyIds } } });
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
  for (const id of replyIds) await append({ messageId: id, removed: true });
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
      prompt: revision.kind === "edit" ? buildSendPrompt(revision.text, []) : plan.run.taskPrompt,
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
    where: { id: message.id, runId: plan.run.id },
    data: { runId: run.id },
  });
  return { runId: run.id, seq };
}
