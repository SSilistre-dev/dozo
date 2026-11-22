import { canonicalPiProviderId } from "@rakazo/contracts";
import { readBotModelBackups, writeBotModelBackups } from "@rakazo/db";
import type { RouterContext } from "./routes/context.js";

/**
 * A bot's own ordered backup models. Whoever may change the bot's model may change them, and
 * each row is checked as a member's own backup is: a pinned connection must be the saver's own,
 * so nobody picks another member's connection. A change signals the Space's apps on the roster
 * stream.
 */
export function dozoBotModelBackupsRoutes(ctx: RouterContext) {
  const { deps, authed, repos, validateRoleChoices } = ctx;
  return {
    dozoBotModelBackups: {
      get: authed.dozoBotModelBackups.get.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        return { backups: await readBotModelBackups(deps.prisma, bot.id) };
      }),
      set: authed.dozoBotModelBackups.set.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        await validateRoleChoices(context.actor, "main", input.backups);
        const backups = input.backups.map((choice) => ({
          ...choice,
          provider: canonicalPiProviderId(choice.provider),
        }));
        await writeBotModelBackups(
          deps.prisma,
          { botId: bot.id, spaceId: context.actor.spaceId },
          backups,
        );
        void deps.events?.publishRosterChange?.({ spaceIds: [context.actor.spaceId] });
        return { backups };
      }),
    },
  };
}
