import { readDozoDailySends, saveDozoDailySends } from "@rakazo/db";
import type { RouterContext } from "./routes/context.js";

/** How many sends each of the signed-in account's bots makes a day without asking (dozo-send-limit.ts in db). */
export function dozoSendLimitRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoSendLimit: {
      get: authed.dozoSendLimit.get.handler(async ({ context }) => ({
        dailySends: await readDozoDailySends(deps.prisma, context.actor.userId),
      })),
      set: authed.dozoSendLimit.set.handler(async ({ context, input }) => {
        await saveDozoDailySends(deps.prisma, context.actor.userId, input.dailySends);
        return { dailySends: input.dailySends };
      }),
    },
  };
}
