import {
  learningMode,
  listLearningChanges,
  setLearningMode,
  undoLearningChange,
} from "@rakazo/adapters";
import { DOZO_LEARNING_CHANGES_SHOWN } from "@rakazo/contracts";
import type { RouterContext } from "./routes/context.js";
import { requireBotRunEditor } from "./routes/dozo-bot-edit.js";

/**
 * A bot's learning from its owner's direct chat (dozo-learning-review.ts in adapters): read and
 * undone as the bot's notes are, by the members who see the bot; turned on or off only by who may
 * change its run settings.
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
        const bot = await requireBotRunEditor(
          deps.prisma,
          context.actor,
          await repos.getBot(context.actor, input.botId),
        );
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
