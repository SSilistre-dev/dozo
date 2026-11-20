import { readDozoQuietHours, saveDozoQuietHours } from "@rakazo/adapters";
import type { RouterContext } from "./routes/context.js";

/** The signed-in account's quiet hours, which hold its scheduled routines (dozo-quiet-hours.ts in adapters). */
export function dozoQuietHoursRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoQuietHours: {
      get: authed.dozoQuietHours.get.handler(async ({ context }) => ({
        hours: await readDozoQuietHours(deps.prisma, context.actor.userId),
      })),
      set: authed.dozoQuietHours.set.handler(async ({ context, input }) => {
        await saveDozoQuietHours(deps, context.actor.userId, input.hours);
        return { hours: input.hours };
      }),
    },
  };
}
