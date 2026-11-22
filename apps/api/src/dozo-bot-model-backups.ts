import type { ModelRoleChoice } from "@rakazo/contracts";
import { canonicalPiProviderId, modelRoleChoiceKey } from "@rakazo/contracts";
import { readBotModelBackups, writeBotModelBackups } from "@rakazo/db";
import type { RouterContext } from "./routes/context.js";

/**
 * A bot's own ordered backup models. Whoever may change the bot's model may change them, and
 * each new or changed row is checked as a member's own backup is: a pinned connection must be
 * the saver's own, so nobody picks another member's connection. A change signals the Space's apps on the roster
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
        // A row another member pinned to their own connection stays as they saved it while it
        // is unchanged, so anyone may add, move or remove the others. Only rows of this bot's
        // saved list count: a new or changed row is checked as the saver's own.
        const saved = await readBotModelBackups(deps.prisma, bot.id);
        const pinned = input.backups.flatMap((choice) =>
          choice.credentialId ? [choice.credentialId] : [],
        );
        const own = new Set(
          pinned.length
            ? (
                await deps.prisma.userModelCredential.findMany({
                  where: { userId: context.actor.userId, id: { in: pinned } },
                  select: { id: true },
                })
              ).map((connection) => connection.id)
            : [],
        );
        const kept = (choice: ModelRoleChoice) =>
          choice.credentialId && !own.has(choice.credentialId)
            ? saved.find((row) => modelRoleChoiceKey(row) === modelRoleChoiceKey(choice))
            : undefined;
        await validateRoleChoices(
          context.actor,
          "main",
          input.backups.filter((choice) => !kept(choice)),
        );
        const backups = input.backups.map((choice) => {
          const row = kept(choice) ?? choice;
          return { ...row, provider: canonicalPiProviderId(row.provider) };
        });
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
