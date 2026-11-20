import { listDozoCommandRules, removeDozoCommandRule } from "@rakazo/db";
import type { RouterContext } from "./routes/context.js";

/** The signed-in member's command rules in the current Space (packages/db/src/dozo-command-rules.ts). */
export function dozoCommandRulesRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoCommandRules: {
      list: authed.dozoCommandRules.list.handler(({ context }) =>
        listDozoCommandRules(deps.prisma, context.actor),
      ),
      remove: authed.dozoCommandRules.remove.handler(async ({ context, input }) => {
        await removeDozoCommandRule(deps.prisma, context.actor, input.id);
        return { ok: true as const };
      }),
    },
  };
}
