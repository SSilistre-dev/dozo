import { botCallsAvailable, readBotCallPermission, writeBotCallPermission } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { RouterContext } from "./routes/context.js";

/**
 * Whether a bot may ring its person from a routine. Only the bot's own person reads or changes
 * it. `available` (the server has calls on and a voice is connected) only decides whether the
 * setting is shown; saving it never depends on it.
 */
export function dozoBotCallsRoutes(ctx: RouterContext) {
  const { deps, authed, repos } = ctx;

  async function state(actor: Actor, botId: string) {
    const bot = await repos.getBot(actor, botId);
    const own = bot.userId === actor.userId;
    const available = own && (await botCallsAvailable(deps, actor.userId));
    return {
      bot,
      own,
      available,
      allowed: own && (await readBotCallPermission(deps.prisma, actor.userId, bot.id)),
    };
  }

  return {
    dozoBotCalls: {
      get: authed.dozoBotCalls.get.handler(async ({ context, input }) => {
        const { available, allowed } = await state(context.actor, input.botId);
        return { available, allowed };
      }),
      set: authed.dozoBotCalls.set.handler(async ({ context, input }) => {
        const { bot, own, available } = await state(context.actor, input.botId);
        if (!own) throw new ClientError("CONFLICT", "Only the bot's own person can change this");
        await writeBotCallPermission(deps.prisma, {
          userId: context.actor.userId,
          botId: bot.id,
          spaceId: context.actor.spaceId,
          allowed: input.allowed,
        });
        return { available, allowed: input.allowed };
      }),
    },
  };
}
