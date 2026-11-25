import type { DozoQuietHoursChange } from "@rakazo/adapters";
import { readDozoQuietHours, saveDozoQuietHours, suggestDozoQuietHours } from "@rakazo/adapters";
import type { DozoQuietHours, DozoQuietRange } from "@rakazo/contracts";
import { dozoQuietHoursOf } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { RouterContext } from "./routes/context.js";
import { windowCounter } from "./http/window-counter.js";

/** Suggestions one account may ask for a minute; each reads four weeks of its messages. */
export const DOZO_QUIET_SUGGEST_PER_MINUTE = 5;

/** Both shapes: `hours` for clients that know one range only, `ranges` for the rest. */
const state = (ranges: DozoQuietRange[]) => ({ hours: dozoQuietHoursOf(ranges), ranges });

/**
 * `ranges` sets every range, an empty list or null turning quiet hours off; otherwise `hours`
 * sets the first range's times, or turns them off with null. A save of neither is refused.
 */
function quietChange(input: {
  hours?: DozoQuietHours | null;
  ranges?: DozoQuietRange[] | null;
}): DozoQuietHoursChange {
  if (input.ranges) return input.ranges;
  if (input.hours) return { hours: input.hours };
  if (input.hours === null || input.ranges === null) return [];
  throw new ClientError("BAD_REQUEST", "Give hours or ranges");
}

/**
 * The signed-in account's quiet hours, which hold its scheduled routines (dozo-quiet-hours.ts in
 * adapters). The suggestion limit is per process, so with several API instances each counts on
 * its own.
 */
export function dozoQuietHoursRoutes(ctx: RouterContext, now: () => number = Date.now) {
  const { deps, authed } = ctx;
  const suggestions = windowCounter(60_000, now);
  return {
    dozoQuietHours: {
      get: authed.dozoQuietHours.get.handler(async ({ context }) =>
        state(await readDozoQuietHours(deps.prisma, context.actor.userId)),
      ),
      set: authed.dozoQuietHours.set.handler(async ({ context, input }) =>
        state(await saveDozoQuietHours(deps, context.actor.userId, quietChange(input))),
      ),
      suggest: authed.dozoQuietHours.suggest.handler(async ({ context }) => {
        if (suggestions(`user:${context.actor.userId}`) > DOZO_QUIET_SUGGEST_PER_MINUTE)
          throw new ClientError("TOO_MANY_REQUESTS", "Too many suggestions, try again in a minute");
        return { ranges: await suggestDozoQuietHours(deps.prisma, context.actor.userId) };
      }),
    },
  };
}
