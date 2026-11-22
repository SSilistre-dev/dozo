import { bestEffort } from "@rakazo/logging";
import type { LearningReviewDeps } from "./dozo-learning-review.js";
import {
  LEARNING_IDLE_MS,
  LEARNING_REVIEW_BACKUP_MS,
  LEARNING_REVIEW_BATCH,
  learningReviewJob,
  reviewLearning,
} from "./dozo-learning-review.js";
import { learningMode, recordLearningTurn } from "./dozo-learning-store.js";
import { runCameByToken } from "./dozo-token-run.js";
import type { RunContext } from "./run-context.js";
import { isRunTainted } from "./run-context.js";
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

const startNow = (work: () => Promise<unknown>) => {
  void bestEffort("learning review", work());
};

const reviewDeps = (ctx: RunContext): LearningReviewDeps => ({
  prisma: ctx.deps.prisma,
  runtime: ctx.deps.runtime,
  memory: ctx.deps.memory,
  secretStore: ctx.deps.secretStore,
  resolveModel: (scope) => resolveRunModel(ctx.deps, scope),
  resolveConnectedModel: (...args) => resolveConnectedRunModel(ctx.deps, ...args),
});

async function recordTurn(ctx: RunContext, start: typeof startNow) {
  if (!countsForLearning(ctx)) return;
  const { deps, run, bot } = ctx;
  // The one read a bot with learning off pays.
  if ((await learningMode(deps.prisma, bot.id)) !== "auto") return;
  if (await runCameByToken(ctx)) return;
  const tainted = await isRunTainted(ctx);
  const now = Date.now();
  const due = await deps.prisma.$transaction(async (tx) => {
    const pending = await recordLearningTurn(tx, {
      botId: bot.id,
      spaceId: run.spaceId,
      threadId: run.threadId,
      runId: run.id,
      messageId: run.sourceMessageId!,
      tainted,
    });
    const batch = pending >= LEARNING_REVIEW_BATCH;
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
