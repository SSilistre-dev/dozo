import { readDozoDailyDigest, saveDozoDailyDigest } from "@rakazo/adapters";
import { IsolationError } from "@rakazo/db";
import type { RouterContext } from "./routes/context.js";

/** The signed-in account's daily digest (dozo-daily-digest.ts in adapters). */
export function dozoDailyDigestRoutes(ctx: RouterContext) {
  const { deps, repos, authed } = ctx;
  return {
    dozoDailyDigest: {
      get: authed.dozoDailyDigest.get.handler(async ({ context }) => ({
        digest: await readDozoDailyDigest(deps.prisma, context.actor.userId),
      })),
      set: authed.dozoDailyDigest.set.handler(async ({ context, input }) => {
        const { actor } = context;
        if (!input.digest) {
          await saveDozoDailyDigest(deps, actor.userId, null);
          return { digest: null };
        }
        // A new bot must be one the caller may use here, with a chat to write in. The bot the
        // digest already has stays checked by its routine, so its time can change from any Space.
        const current = await readDozoDailyDigest(deps.prisma, actor.userId);
        let spaceId: string;
        if (current?.botId === input.digest.botId) {
          const bot = await deps.prisma.bot.findUnique({
            where: { id: input.digest.botId },
            select: { spaceId: true },
          });
          if (!bot) throw new IsolationError();
          spaceId = bot.spaceId;
        } else {
          const bot = await repos.getBot(actor, input.digest.botId);
          if (!bot.thread) throw new IsolationError();
          spaceId = bot.spaceId;
        }
        await saveDozoDailyDigest(deps, actor.userId, { ...input.digest, spaceId });
        return { digest: await readDozoDailyDigest(deps.prisma, actor.userId) };
      }),
    },
  };
}
