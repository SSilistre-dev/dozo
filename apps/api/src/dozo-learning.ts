import {
  learningMode,
  learningAvailable,
  listLearningChanges,
  setLearningMode,
  settleLeftLearningWrites,
  undoLearningChange,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { DOZO_LEARNING_CHANGES_SHOWN } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { RouterContext } from "./routes/context.js";

/** Learning turns the owner's own chat into notes: only they see, switch and undo it. */
export class DozoLearningOwnerOnlyError extends ClientError {
  constructor() {
    super("FORBIDDEN", "Only the bot's owner can manage what it learns.");
  }
}

/** Notes are read by every member of a Space: a shared one does not learn from the owner's chat. */
export class DozoLearningSharedSpaceError extends ClientError {
  constructor() {
    super("CONFLICT", "Learning works only in a Space of your own.");
  }
}

/**
 * A bot's learning from its owner's direct chat (dozo-learning-review.ts in adapters): read,
 * switched and undone only by the bot's owner, whose own chat it learns from, and only in a Space
 * nobody else is a member of.
 */
export function dozoLearningRoutes(ctx: RouterContext) {
  const { deps, repos, authed } = ctx;
  const ownBot = async (actor: Actor, botId: string) => {
    const bot = await repos.getBot(actor, botId);
    if (bot.userId !== actor.userId) throw new DozoLearningOwnerOnlyError();
    return bot;
  };
  const available = (bot: { spaceId: string; userId: string }) =>
    learningAvailable(deps.prisma, bot);
  return {
    dozoLearning: {
      get: authed.dozoLearning.get.handler(async ({ context, input }) => {
        const bot = await ownBot(context.actor, input.botId);
        await settleLeftLearningWrites(deps.prisma, bot, false);
        const [mode, open, changes] = await Promise.all([
          learningMode(deps.prisma, input.botId),
          available(bot),
          listLearningChanges(deps.prisma, input.botId, DOZO_LEARNING_CHANGES_SHOWN),
        ]);
        return {
          mode: mode === "auto" ? ("auto" as const) : ("off" as const),
          available: open,
          changes,
        };
      }),
      setMode: authed.dozoLearning.setMode.handler(async ({ context, input }) => {
        const bot = await ownBot(context.actor, input.botId);
        if (input.mode === "auto" && !(await available(bot)))
          throw new DozoLearningSharedSpaceError();
        await setLearningMode(deps.prisma, bot, input.mode);
        return { mode: input.mode };
      }),
      undo: authed.dozoLearning.undo.handler(async ({ context, input }) =>
        undoLearningChange(deps, context.actor, input.changeId, (botId) =>
          ownBot(context.actor, botId),
        ),
      ),
    },
  };
}
