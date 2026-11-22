import { bestEffort } from "@rakazo/logging";
import { runRecalledMemory } from "./dozo-learning-recall.js";
import type { LearningReviewDeps } from "./dozo-learning-review.js";
import {
  LEARNING_IDLE_MS,
  LEARNING_REVIEW_BACKUP_MS,
  LEARNING_REVIEW_BATCH,
  LEARNING_REVIEW_MIN_TURNS,
  learningReviewJob,
  reviewLearning,
} from "./dozo-learning-review.js";
import { learningMode, recordLearningTurn } from "./dozo-learning-store.js";
import { onlyOwnerReads, runReadPhone } from "./dozo-phone.js";
import { runReadOutsideContent } from "./dozo-read-outside.js";
import { runCameByToken } from "./dozo-token-run.js";
import type { RunContext } from "./run-context.js";
import { resolveConnectedRunModel, resolveRunModel } from "./run-model.js";

/**
 * Only the bot owner's own direct chat teaches it: the owner's message started the run in the
 * bot's own chat. A shared Space's other members, chat apps, webhooks, routines, other bots,
 * groups, helpers and token messages never do, so nobody else's words become the owner's notes.
 */
export function countsForLearning(ctx: Pick<RunContext, "run" | "thread" | "bot" | "source">) {
  const { run, thread, bot, source } = ctx;
  return (
    (run.trigger === "user" || run.trigger === "follow_up") &&
    source.ownerStartedRun &&
    !source.messagingChannelRun &&
    Boolean(run.sourceMessageId) &&
    run.userId === bot.userId &&
    thread.botId === run.botId &&
    !thread.groupId &&
    !thread.externalConversationId &&
    !thread.helperBotId
  );
}

/**
 * Tools that show the model more than this turn: another chat, saved memory or a skill's text. A
 * reply written after one may repeat what they returned, which is not the owner's.
 */
const READS_BEYOND_THE_TURN = new Set([
  "recall_memory",
  "reflect_memory",
  "search_history",
  "read_history",
  "skill_read",
]);

/**
 * Whether the review may read the bot's reply of this turn: the run read no outside content, its
 * model was shown no recalled memory, and it called none of the tools above. Otherwise the review
 * reads only the owner's own words of the turn.
 */
export async function botReplyReadable(
  ctx: Pick<RunContext, "deps" | "runId" | "state" | "trust">,
): Promise<boolean> {
  if (runRecalledMemory(ctx.state)) return false;
  if (ctx.state.reply.toolCalls.some((call) => call.tool && READS_BEYOND_THE_TURN.has(call.tool)))
    return false;
  return !(await runReadOutsideContent(ctx));
}

const startNow = (work: () => Promise<unknown>) => {
  void bestEffort("learning review", work());
};

const reviewDeps = (ctx: RunContext): LearningReviewDeps => ({
  prisma: ctx.deps.prisma,
  runtime: ctx.deps.runtime,
  memory: ctx.deps.memory,
  secretStore: ctx.deps.secretStore,
  paymentWallet: ctx.deps.paymentWallet,
  resolveModel: (scope) => resolveRunModel(ctx.deps, scope),
  resolveConnectedModel: (...args) => resolveConnectedRunModel(ctx.deps, ...args),
});

async function recordTurn(ctx: RunContext, start: typeof startNow) {
  if (!countsForLearning(ctx)) return;
  const { deps, run, bot } = ctx;
  // The one read a bot with learning off pays.
  if ((await learningMode(deps.prisma, bot.id)) !== "auto") return;
  if ((await runCameByToken(ctx)) || (await runReadPhone(ctx))) return;
  // Notes are read by every member of the Space: learning is for a Space of the owner's own.
  if (!(await onlyOwnerReads(deps.prisma, ctx.thread, bot.userId))) return;
  const readable = await botReplyReadable(ctx);
  const now = Date.now();
  const due = await deps.prisma.$transaction(async (tx) => {
    const pending = await recordLearningTurn(tx, {
      botId: bot.id,
      spaceId: run.spaceId,
      threadId: run.threadId,
      runId: run.id,
      messageId: run.sourceMessageId!,
      botReplyReadable: readable,
    });
    const batch = pending >= LEARNING_REVIEW_BATCH;
    // Too few to review even after a pause: they wait for more.
    if (pending < LEARNING_REVIEW_MIN_TURNS) return false;
    // The bot's one job: the backup of the review started below, or the wait for a pause.
    await deps.jobs.enqueueIn(
      tx,
      learningReviewJob(
        bot.id,
        new Date(now + (batch ? LEARNING_REVIEW_BACKUP_MS : LEARNING_IDLE_MS)),
      ),
    );
    return batch;
  });
  if (due) start(() => reviewLearning(reviewDeps(ctx), bot.id));
}

/**
 * After a run completed: records the turn for the bot's next learning review when its owner has
 * learning on, and starts the review at once when enough turns wait. Never fails the run.
 */
export async function dozoRecordLearningTurn(ctx: RunContext, start = startNow): Promise<void> {
  await bestEffort("learning turn", recordTurn(ctx, start));
}
