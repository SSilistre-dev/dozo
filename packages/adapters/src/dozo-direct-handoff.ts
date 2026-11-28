import type { MessageBlock } from "@rakazo/contracts";
import {
  botMessageContext,
  botMessageHopExhausted,
  nextBotMessageHop,
  redactSecrets,
  resolveBotAddress,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  isUniqueViolation,
  spaceTakesWork,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import {
  conversationLine,
  DIRECT_HANDOFF_OWN_BOTS_ONLY,
  directHandoffDoneNote,
  directHandoffTaskPrompt,
} from "./dozo-direct-handoff.prompt.js";
import { dozoMarkReached } from "./dozo-token-marks.js";
import { unresolvedBotError } from "./messaging/bot-messages.js";
import type { RunContext } from "./runs/assembly/run-context.js";
import { runLeaseFor } from "./runs/assembly/run-messages.js";
import type { ToolCall } from "./runs/tools/run-tool-gate.js";
import type { AttachmentBlock } from "./runs/tools/run-tools-files.js";
import { wakeRun } from "./runs/wakeups/wake-run.js";

/** The part of the handing chat the next bot reads: its latest messages, within a size. */
export const HANDOFF_CONTEXT_MESSAGES = 20;
export const HANDOFF_CONTEXT_MESSAGE_CHARS = 1_000;
export const HANDOFF_CONTEXT_CHARS = 6_000;

/** The file and message checks handoff_to_bot already uses (run-tools-messaging.ts). */
export type DirectHandoffKit = {
  messageError: (ctx: RunContext, message: unknown) => string | undefined;
  prepareSentFiles: (
    ctx: RunContext,
    call: ToolCall,
    recipient: { botId?: string; name?: string },
  ) => Promise<
    { error: string } | { files: AttachmentBlock[]; sharedPaths: string[]; recipientId?: string }
  >;
  deliveredMessage: (
    ctx: RunContext,
    message: unknown,
    sharedPaths: string[],
  ) => { error: string } | { message: string };
};

type HandoffBlock = Extract<MessageBlock, { kind: "handoff" }>;

const optional = (value: unknown) => (value ? String(value) : undefined);

/**
 * handoff_to_bot from a one-to-one chat, with no group: another of the user's own bots takes the
 * conversation over in its own chat. Both chats get the handoff, the next bot starts at once with
 * the note, the files and the latest messages, and this bot ends its turn with one line.
 */
export async function dozoDirectHandoff(
  ctx: RunContext,
  call: ToolCall,
  kit: DirectHandoffKit,
): Promise<unknown> {
  const { deps, run, bot, thread } = ctx;
  const { args } = call;
  if (
    ctx.source.messagingChannelRun ||
    ctx.source.voiceCall ||
    thread.botId !== bot.id ||
    bot.userId !== run.userId
  ) {
    return call.finish({
      error:
        "group_id is required here: only the user's own chat with you in the app can be handed to another bot",
    });
  }
  const invalid = kit.messageError(ctx, args.message);
  if (invalid) return call.finish({ error: invalid });
  const candidates = await deps.prisma.bot.findMany({
    where: { spaceId: run.spaceId, userId: run.userId, archivedAt: null },
    select: { id: true, name: true, thread: { select: { id: true } } },
  });
  const target = resolveBotAddress(candidates, {
    botId: optional(args.bot_id),
    name: optional(args.confirm_name),
  });
  if (!target) {
    return call.finish({
      error: `${unresolvedBotError(candidates, bot.id)}. ${DIRECT_HANDOFF_OWN_BOTS_ONLY}`,
    });
  }
  if (target.id === bot.id) return call.finish({ error: "cannot hand off to yourself" });
  if (!target.thread) return call.finish({ error: `${target.name} has no chat to hand over to` });
  const source = await sourceHandoff(deps.prisma, run.sourceMessageId);
  if (source.fromBotId === target.id) {
    return call.finish({
      error: `${target.name} just handed this to you. Finish it yourself or tell the user.`,
    });
  }
  if (botMessageHopExhausted(source.hop)) {
    return call.finish({
      error: "handoff limit reached for this chain; finish the work yourself or tell the user",
    });
  }
  const stored = await kit.prepareSentFiles(ctx, call, { botId: target.id });
  if ("error" in stored) return call.finish({ error: stored.error });
  const delivered = kit.deliveredMessage(ctx, args.message, stored.sharedPaths);
  if ("error" in delivered) return call.finish({ error: delivered.error });
  const block: HandoffBlock = {
    kind: "handoff",
    fromBotId: bot.id,
    toBotId: target.id,
    text: delivered.message.trim(),
    hop: source.hop,
  };
  const conversation = await recentConversation(deps.prisma, run.threadId, bot.name);
  const committed = await commitHandoff(ctx, {
    block,
    files: stored.files,
    targetThreadId: target.thread.id,
    deliveryKey: `dozo-handoff:${call.effectKey}`,
    taskPrompt: directHandoffTaskPrompt({
      fromName: sanitizeMessagingLabel(bot.name),
      note: block.text,
      conversation: redactSecrets(conversation, ctx.secrets),
    }),
  });
  if ("error" in committed) return call.finish({ error: committed.error });
  const done = { ok: true, botId: target.id, name: target.name };
  if (!("replayed" in committed)) {
    await deps.events.notify(target.thread.id, committed.targetSeq);
    await deps.events.notify(run.threadId, committed.sourceSeq);
    await wakeRun(deps.jobs, committed.runId);
  }
  return call.finish({ ...done, note: directHandoffDoneNote(target.name) });
}

/** The handoff that started this run, if any: who sent it and the hop the next one takes. */
async function sourceHandoff(prisma: PrismaClient, sourceMessageId: string | null) {
  const source = sourceMessageId
    ? await prisma.message.findUnique({
        where: { id: sourceMessageId },
        select: { id: true, blocks: true },
      })
    : null;
  const blocks = source ? storedMessageBlocks(source) : [];
  const handoff = blocks.find((block): block is HandoffBlock => block.kind === "handoff");
  return {
    fromBotId: handoff?.fromBotId,
    hop: nextBotMessageHop(handoff?.hop ?? botMessageContext(blocks)?.hop),
  };
}

/** The latest text of the chat, oldest first, each message and the whole kept within a size. */
export async function recentConversation(
  prisma: PrismaClient,
  threadId: string,
  botName: string,
): Promise<string> {
  const rows = await prisma.message.findMany({
    where: { threadId, role: { in: ["user", "bot"] } },
    orderBy: { seq: "desc" },
    take: HANDOFF_CONTEXT_MESSAGES,
    select: { id: true, role: true, blocks: true },
  });
  const lines: string[] = [];
  let used = 0;
  for (const row of rows) {
    const text = storedMessageBlocks(row)
      .flatMap((block) => (block.kind === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    if (!text) continue;
    const clipped =
      text.length > HANDOFF_CONTEXT_MESSAGE_CHARS
        ? `${text.slice(0, HANDOFF_CONTEXT_MESSAGE_CHARS - 1)}…`
        : text;
    const line = conversationLine(row.role === "bot" ? botName : undefined, clipped);
    if (used + line.length > HANDOFF_CONTEXT_CHARS) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

type Committed =
  | { error: string }
  | { replayed: true }
  | { runId: string; targetSeq: number; sourceSeq: number };

/**
 * One transaction: the handoff in this chat and in the next bot's, and its queued run. The
 * delivery key makes a retried call a replay, and one turn hands its chat over only once.
 */
async function commitHandoff(
  ctx: RunContext,
  input: {
    block: HandoffBlock;
    files: AttachmentBlock[];
    targetThreadId: string;
    deliveryKey: string;
    taskPrompt: string;
  },
): Promise<Committed> {
  const { deps, run } = ctx;
  const { block, targetThreadId, deliveryKey } = input;
  const replay = () =>
    deps.prisma.message.findUnique({
      where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
      select: { id: true },
    });
  try {
    return await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx): Promise<Committed> => {
        if (!(await spaceTakesWork(tx, run.spaceId)))
          return { error: "this Space is being deleted" };
        for (const threadId of [run.threadId, targetThreadId].sort()) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        }
        const already = await tx.message.findUnique({
          where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
          select: { id: true },
        });
        if (already) return { replayed: true };
        const active = await tx.run.findFirst({
          where: {
            id: run.id,
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            userId: run.userId,
            status: "running",
          },
          select: { id: true },
        });
        if (!active) return { error: "source run is no longer active" };
        const written = await tx.message.findMany({
          where: { threadId: run.threadId, runId: run.id },
          select: { id: true, blocks: true },
        });
        if (written.some((m) => storedMessageBlocks(m).some((b) => b.kind === "handoff"))) {
          return { error: "this turn already handed the chat over" };
        }
        const target = await tx.bot.findFirst({
          where: { id: block.toBotId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
          select: { id: true },
        });
        if (!target) return { error: "that bot is no longer available" };
        // A handoff from a bot marked by a token's message marks the bot it reaches.
        await dozoMarkReached(tx, { run, targetBotId: block.toBotId });
        const lease = runLeaseFor(deps, run.id);
        const outbound = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          role: "bot",
          blocks: [block],
          botId: run.botId,
          runId: run.id,
          lease,
        });
        // The next bot's own message, so its later turns read the handoff as theirs to carry on.
        const blocks: MessageBlock[] = [block, ...input.files];
        const inbound = await createThreadMessageInTransaction(tx, {
          threadId: targetThreadId,
          role: "bot",
          blocks,
          botId: block.toBotId,
          clientNonce: deliveryKey,
        });
        const task = await tx.task.create({
          data: {
            spaceId: run.spaceId,
            botId: block.toBotId,
            threadId: targetThreadId,
            userId: run.userId,
            prompt: input.taskPrompt,
            status: "queued",
          },
        });
        const nextRun = await tx.run.create({
          data: {
            spaceId: run.spaceId,
            botId: block.toBotId,
            threadId: targetThreadId,
            taskId: task.id,
            userId: run.userId,
            status: "queued",
            trigger: "follow_up",
            sourceMessageId: inbound.id,
          },
          select: { id: true },
        });
        const targetEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: targetThreadId,
          botId: block.toBotId,
          type: "thread.message.created",
          payload: { messageId: inbound.id, role: "bot", blocks },
        });
        const sourceEvent = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "thread.message.created",
          runId: run.id,
          lease,
          payload: { messageId: outbound.id, role: "bot", blocks: [block] },
        });
        return { runId: nextRun.id, targetSeq: targetEvent.seq, sourceSeq: sourceEvent.seq };
      }, THREAD_LOCK_TRANSACTION_OPTIONS),
    );
  } catch (error) {
    // Two retries of one call can both miss the lookup; the loser hits the unique key.
    if (isUniqueViolation(error) && (await replay())) return { replayed: true };
    throw error;
  }
}
