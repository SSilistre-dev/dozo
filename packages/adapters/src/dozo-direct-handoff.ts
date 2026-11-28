import { MessageBlock } from "@rakazo/contracts";
import {
  botMessageContext,
  botMessageHopExhausted,
  nextBotMessageHop,
  redactSecrets,
  resolveBotAddress,
  sanitizeMessagingLabel,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  isUniqueViolation,
  readMessageBlocks,
  spaceTakesWork,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import {
  conversationLine,
  DIRECT_HANDOFF_LINE_REQUIRED,
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
import {
  neutralizeSpeakerLabels,
  speakerName,
  USER_SPEAKER,
} from "./runtime/context/history-speakers.js";

/** The part of the handing chat the next bot reads: its latest messages, within a size. */
export const HANDOFF_CONTEXT_MESSAGES = 20;
export const HANDOFF_CONTEXT_MESSAGE_CHARS = 1_000;
export const HANDOFF_CONTEXT_CHARS = 6_000;
/** The handing bot's one line to the user. */
export const HANDOFF_LINE_CHARS = 280;

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
type Db = PrismaClient | Prisma.TransactionClient;
type Source = Awaited<ReturnType<typeof sourceHandoff>>;

const optional = (value: unknown) => (value ? String(value) : undefined);

/**
 * handoff_to_bot from a one-to-one chat, with no group: another of the user's own bots takes the
 * conversation over in its own chat. Both chats get the handoff, the next bot starts at once with
 * the note, the files and the latest messages, and this bot's turn ends with its one line.
 */
export async function dozoDirectHandoff(
  ctx: RunContext,
  call: ToolCall,
  kit: DirectHandoffKit,
): Promise<unknown> {
  const { deps, run, bot } = ctx;
  const { args } = call;
  const source = await sourceHandoff(deps.prisma, run.sourceMessageId);
  if (!canHandOver(ctx, source)) {
    return call.finish({
      error:
        "group_id is required here: only a turn the user started in their own chat with you in the app, or one a handoff started, can hand the chat to another bot",
    });
  }
  if (!source.intact) {
    return call.finish({ error: "cannot verify the handoff chain; finish the work yourself" });
  }
  const invalid = kit.messageError(ctx, args.message);
  if (invalid) return call.finish({ error: invalid });
  const line = redactSecrets(String(args.user_message ?? ""), ctx.secrets)
    .trim()
    .split("\n")[0]!
    .slice(0, HANDOFF_LINE_CHARS)
    .trim();
  if (!line) return call.finish({ error: DIRECT_HANDOFF_LINE_REQUIRED });
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
  const done = () => {
    ctx.state.handedOff = true;
    return call.finish({
      ok: true,
      botId: target.id,
      name: target.name,
      note: directHandoffDoneNote(target.name),
    });
  };
  const handoff = {
    targetId: target.id,
    targetThreadId: target.thread.id,
    deliveryKey: `dozo-handoff:${call.effectKey}`,
  };
  // Checked before any file is copied for the next bot, and again inside the transaction.
  const early = await refusal(deps.prisma, ctx, handoff);
  if (early && "error" in early) return call.finish({ error: early.error });
  if (early) return done();
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
  const conversation = await recentConversation(deps.prisma, run.threadId, bot);
  const committed = await commitHandoff(ctx, {
    ...handoff,
    block,
    line,
    files: stored.files,
    taskPrompt: directHandoffTaskPrompt({
      fromName: sanitizeMessagingLabel(bot.name),
      note: block.text,
      conversation: redactSecrets(conversation, ctx.secrets),
    }),
  });
  if ("error" in committed) return call.finish({ error: committed.error });
  if (!("replayed" in committed)) {
    await deps.events.notify(target.thread.id, committed.targetSeq);
    await deps.events.notify(run.threadId, committed.sourceSeq);
    await wakeRun(deps.jobs, committed.runId);
  }
  return done();
}

/**
 * Only the user's own chat with this bot in the app, in a turn the user started there or one a
 * handoff started. Never a routine, a helper or another background run, whose input nobody
 * watches, a chat reached from a messaging app, or a call.
 */
function canHandOver(ctx: RunContext, source: Source): boolean {
  const { run, bot, thread } = ctx;
  return (
    !ctx.source.messagingChannelRun &&
    !ctx.source.voiceCall &&
    thread.botId === bot.id &&
    bot.userId === run.userId &&
    (run.trigger === "user" || run.trigger === "follow_up") &&
    (ctx.source.ownerStartedRun || source.fromBotId !== undefined)
  );
}

/**
 * The handoff that started this run, if any: who sent it and the hop the next one takes. A
 * source message that lost entries, or whose handoff does not parse, may hide the chain's hop.
 */
async function sourceHandoff(prisma: PrismaClient, sourceMessageId: string | null) {
  const source = sourceMessageId
    ? await prisma.message.findUnique({
        where: { id: sourceMessageId },
        select: { id: true, blocks: true },
      })
    : null;
  const read = source ? readMessageBlocks(source) : { blocks: [], intact: true };
  const handoff = read.blocks.find((block): block is HandoffBlock => block.kind === "handoff");
  return {
    intact: read.intact && (!handoff || MessageBlock.safeParse(handoff).success),
    fromBotId: handoff?.fromBotId,
    hop: nextBotMessageHop(handoff?.hop ?? botMessageContext(read.blocks)?.hop),
  };
}

/**
 * The latest text of the chat, oldest first, each message and the whole kept within a size. Each
 * message is labelled with its speaker, and a line inside it that looks like a label is
 * neutralized, so quoted text cannot pass for the user speaking.
 */
export async function recentConversation(
  prisma: PrismaClient,
  threadId: string,
  bot: { id: string; name: string },
): Promise<string> {
  const rows = await prisma.message.findMany({
    where: { threadId, role: { in: ["user", "bot"] } },
    orderBy: { seq: "desc" },
    take: HANDOFF_CONTEXT_MESSAGES,
    select: { id: true, role: true, botId: true, blocks: true },
  });
  const lines: string[] = [];
  let used = 0;
  for (const row of rows) {
    if (row.role === "bot" && row.botId !== bot.id) continue;
    const text = storedMessageBlocks(row)
      .flatMap((block) => (block.kind === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    if (!text) continue;
    const clipped =
      text.length > HANDOFF_CONTEXT_MESSAGE_CHARS
        ? `${text.slice(0, HANDOFF_CONTEXT_MESSAGE_CHARS - 1)}…`
        : text;
    const speaker = row.role === "bot" ? speakerName(bot.name) : USER_SPEAKER;
    const line = conversationLine(speaker, neutralizeSpeakerLabels(clipped));
    if (used + line.length > HANDOFF_CONTEXT_CHARS) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

type Handoff = { targetId: string; targetThreadId: string; deliveryKey: string };

/** Why the handoff cannot be written now, or that this call already wrote it. */
async function refusal(
  db: Db,
  ctx: RunContext,
  handoff: Handoff,
): Promise<{ error: string } | { replayed: true } | undefined> {
  const { run } = ctx;
  if (!(await spaceTakesWork(db, run.spaceId))) return { error: "this Space is being deleted" };
  const already = await db.message.findUnique({
    where: {
      threadId_clientNonce: { threadId: handoff.targetThreadId, clientNonce: handoff.deliveryKey },
    },
    select: { id: true },
  });
  if (already) return { replayed: true };
  const active = await db.run.findFirst({
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
  const written = await db.message.findMany({
    where: { threadId: run.threadId, runId: run.id },
    select: { id: true, blocks: true },
  });
  if (written.some((m) => storedMessageBlocks(m).some((b) => b.kind === "handoff"))) {
    return { error: "this turn already handed the chat over" };
  }
  const target = await db.bot.findFirst({
    where: { id: handoff.targetId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
    select: { id: true },
  });
  if (!target) return { error: "that bot is no longer available" };
}

type Committed =
  | { error: string }
  | { replayed: true }
  | { runId: string; targetSeq: number; sourceSeq: number };

/**
 * One transaction: this bot's line and the handoff in its chat, the handoff in the next bot's,
 * and the next bot's queued run. The delivery key makes a retried call a replay.
 */
async function commitHandoff(
  ctx: RunContext,
  input: Handoff & {
    block: HandoffBlock;
    line: string;
    files: AttachmentBlock[];
    taskPrompt: string;
  },
): Promise<Committed> {
  const { deps, run } = ctx;
  const { block, targetThreadId, deliveryKey } = input;
  try {
    return await withTransactionRetry(() =>
      deps.prisma.$transaction(async (tx): Promise<Committed> => {
        for (const threadId of [run.threadId, targetThreadId].sort()) {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        }
        const refused = await refusal(tx, ctx, input);
        if (refused) return refused;
        // A handoff from a bot marked by a token's message marks the bot it reaches.
        await dozoMarkReached(tx, { run, targetBotId: block.toBotId });
        const lease = runLeaseFor(deps, run.id);
        const own = async (blocks: MessageBlock[]) => {
          const message = await createThreadMessageInTransaction(tx, {
            threadId: run.threadId,
            role: "bot",
            blocks,
            botId: run.botId,
            runId: run.id,
            lease,
          });
          return appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            type: "thread.message.created",
            runId: run.id,
            lease,
            payload: { messageId: message.id, role: "bot", blocks },
          });
        };
        await own([{ kind: "text", text: input.line }]);
        const sourceEvent = await own([block]);
        // The next bot's own message, so the run it starts is not the user's; its history reads
        // the handoff as a line from the handing bot (the run-assembly-history rule).
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
        return { runId: nextRun.id, targetSeq: targetEvent.seq, sourceSeq: sourceEvent.seq };
      }, THREAD_LOCK_TRANSACTION_OPTIONS),
    );
  } catch (error) {
    // Two retries of one call can both miss the lookup; the loser hits the unique key.
    if (isUniqueViolation(error)) {
      const winner = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: targetThreadId, clientNonce: deliveryKey } },
        select: { id: true },
      });
      if (winner) return { replayed: true };
    }
    throw error;
  }
}
