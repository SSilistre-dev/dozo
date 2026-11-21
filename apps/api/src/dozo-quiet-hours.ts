import { readDozoQuietHours, saveDozoQuietHours, suggestDozoQuietHours } from "@rakazo/adapters";
import type { DozoQuietRange } from "@rakazo/contracts";
import { DOZO_QUIET_DAYS, dozoQuietHoursOf } from "@rakazo/contracts";
import type { RouterContext } from "./routes/context.js";

/** Both shapes: `hours` for clients that know one range only, `ranges` for the rest. */
const state = (ranges: DozoQuietRange[]) => ({ hours: dozoQuietHoursOf(ranges), ranges });

/** The signed-in account's quiet hours, which hold its scheduled routines (dozo-quiet-hours.ts in adapters). */
export function dozoQuietHoursRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoQuietHours: {
      get: authed.dozoQuietHours.get.handler(async ({ context }) =>
        state(await readDozoQuietHours(deps.prisma, context.actor.userId)),
      ),
      set: authed.dozoQuietHours.set.handler(async ({ context, input }) => {
        const ranges =
          input.ranges ?? (input.hours ? [{ ...input.hours, days: DOZO_QUIET_DAYS.ALL }] : []);
        await saveDozoQuietHours(deps, context.actor.userId, ranges);
        return state(ranges);
      }),
      suggest: authed.dozoQuietHours.suggest.handler(async ({ context }) => ({
        ranges: await suggestDozoQuietHours(deps.prisma, context.actor.userId),
      })),
    },
  };
}
