import {
  learningMode,
  listLearningChanges,
  setLearningMode,
  undoLearningChange,
} from "@rakazo/adapters";
import { DOZO_LEARNING_CHANGES_SHOWN } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { RouterContext } from "./routes/context.js";

/** Learning turns the owner's own chat into notes every member reads: only they decide. */
export class DozoLearningOwnerOnlyError extends ClientError {
  constructor() {
    super("FORBIDDEN", "Only the bot's owner can turn learning on or off.");
  }
}

/**
 * A bot's learning from its owner's direct chat (dozo-learning-review.ts in adapters): read and
 * undone as the bot's notes are, by the members who see the bot; turned on or off only by the
 * bot's owner, whose own chat it learns from.
 */
export function dozoLearningRoutes(ctx: RouterContext) {
  const { deps, repos, authed } = ctx;
  return {
    dozoLearning: {
      get: authed.dozoLearning.get.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const [mode, changes] = await Promise.all([
          learningMode(deps.prisma, input.botId),
          listLearningChanges(deps.prisma, input.botId, DOZO_LEARNING_CHANGES_SHOWN),
        ]);
        return { mode: mode === "auto" ? ("auto" as const) : ("off" as const), changes };
      }),
      setMode: authed.dozoLearning.setMode.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (bot.userId !== context.actor.userId) throw new DozoLearningOwnerOnlyError();
        await setLearningMode(deps.prisma, bot, input.mode);
        return { mode: input.mode };
      }),
      undo: authed.dozoLearning.undo.handler(async ({ context, input }) =>
        undoLearningChange(deps, context.actor, input.changeId, (botId) =>
          repos.getBot(context.actor, botId),
        ),
      ),
    },
  };
}
