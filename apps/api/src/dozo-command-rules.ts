import { ClientError, prefixRuleAllowed } from "@rakazo/core";
import {
  dozoSpaceHasComputer,
  findDozoCommandRule,
  listDozoCommandRules,
  readDozoHostedAsks,
  removeDozoCommandRule,
  saveDozoHostedAsks,
  updateDozoCommandRule,
} from "@rakazo/db";
import type { RouterContext } from "./routes/context.js";

/** A rule the member does not have in this Space, theirs or not: another member's looks the same. */
export class CommandRuleNotFoundError extends ClientError {
  constructor() {
    super("NOT_FOUND", "This rule no longer exists.");
    this.name = "CommandRuleNotFoundError";
  }
}

/** Any arguments after a program that runs what they name would allow anything. */
export class CommandPrefixNotAllowedError extends ClientError {
  constructor() {
    super("BAD_REQUEST", "This command can only be allowed exactly.");
    this.name = "CommandPrefixNotAllowedError";
  }
}

/**
 * The signed-in member's command rules in the current Space, and whether commands on the bot's
 * computer ask them (packages/db/src/dozo-command-rules.ts).
 */
export function dozoCommandRulesRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const hostedAsks = async (actor: { userId: string; spaceId: string }) => ({
    hostedAsks: (await dozoSpaceHasComputer(deps.prisma, actor.spaceId))
      ? await readDozoHostedAsks(deps.prisma, actor.userId)
      : null,
  });
  return {
    dozoCommandRules: {
      list: authed.dozoCommandRules.list.handler(({ context }) =>
        listDozoCommandRules(deps.prisma, context.actor),
      ),
      update: authed.dozoCommandRules.update.handler(async ({ context, input }) => {
        const rule = await findDozoCommandRule(deps.prisma, context.actor, input.id);
        if (!rule) throw new CommandRuleNotFoundError();
        if (input.effect === "allow_prefix" && !prefixRuleAllowed(rule.words, rule.cwd))
          throw new CommandPrefixNotAllowedError();
        await deps.prisma.$transaction((tx) =>
          updateDozoCommandRule(tx, context.actor, input.id, input.effect),
        );
        return { ok: true as const };
      }),
      remove: authed.dozoCommandRules.remove.handler(async ({ context, input }) => {
        await deps.prisma.$transaction((tx) => removeDozoCommandRule(tx, context.actor, input.id));
        return { ok: true as const };
      }),
      getHostedAsks: authed.dozoCommandRules.getHostedAsks.handler(({ context }) =>
        hostedAsks(context.actor),
      ),
      setHostedAsks: authed.dozoCommandRules.setHostedAsks.handler(async ({ context, input }) => {
        await saveDozoHostedAsks(deps.prisma, context.actor.userId, input.hostedAsks);
        return hostedAsks(context.actor);
      }),
    },
  };
}
