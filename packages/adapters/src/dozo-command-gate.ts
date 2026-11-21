import type { DozoCommandComputer } from "@rakazo/core";
import {
  approvalModeFromPreference,
  commandRuleCwd,
  matchCommandRules,
  readOnlyPipeline,
} from "@rakazo/core";
import { readDozoCommandRules, readDozoHostedAsks } from "@rakazo/db";
import type { RunContext } from "./run-context.js";

/** The tool that runs a command on the bot's own computer. */
export const HOSTED_SHELL_TOOL = "shell";

/** Calls a block rule refused, so the refusal says why. */
const commandBlocks = new WeakSet<Record<string, unknown>>();
/** Calls asked about one by one, so their card asks about the command alone. */
const commandAsks = new WeakSet<Record<string, unknown>>();

export const markCommandAsk = (args: Record<string, unknown>) => commandAsks.add(args);
export const commandAsked = (args: Record<string, unknown>) => commandAsks.has(args);

/**
 * What the rules of the run's member for this bot say about the call's command on this computer
 * (packages/core/src/dozo-command-rule-match.ts). In a group chat the rules are those of the member
 * whose run it is. A call a block rule refuses is remembered for its refusal.
 */
export async function commandRuleMatch(
  ctx: RunContext,
  args: Record<string, unknown>,
  computer: DozoCommandComputer,
): Promise<ReturnType<typeof matchCommandRules>> {
  const rules = await readDozoCommandRules(ctx.deps.prisma, {
    userId: ctx.run.userId,
    botId: ctx.bot.id,
  });
  const match = matchCommandRules(rules, {
    command: String(args.command ?? ""),
    cwd: commandRuleCwd(args.cwd),
    computer,
  });
  if (match === "block") commandBlocks.add(args);
  return match;
}

/**
 * Upstream's plan for a command on the bot's computer, then the member's command rules. A block
 * rule refuses it in every mode. An exact allow rule lets it go ahead where upstream asks only
 * because outside text started the run, as an always-allow rule for the tool would; a prefix rule
 * never does that, and a rule asking for the whole tool still asks. Otherwise nothing changes,
 * unless the member asked for commands on the bot's computer to ask: then, outside Never ask, a
 * command that does more than read and that no allow rule (theirs, or upstream's for the tool)
 * covers asks. A run reached by a token's text is gated after this (dozo-token-run.ts).
 */
export async function dozoHostedCommandGate<Plan extends string>(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  resolved: { decision: string; source?: string },
  plan: Plan,
): Promise<Plan | "deny" | "ask" | "allow"> {
  if (name !== HOSTED_SHELL_TOOL || plan === "deny") return plan;
  const match = await commandRuleMatch(ctx, args, "hosted");
  if (match === "block") return "deny";
  if (plan !== "allow") return match === "allow" && resolved.decision !== "ask" ? "allow" : plan;
  if (match || resolved.source === "always_allow") return plan;
  if (approvalModeFromPreference(await ctx.trust.loadAutoReviewPreference()) === "never")
    return plan;
  if (!(await readDozoHostedAsks(ctx.deps.prisma, ctx.run.userId))) return plan;
  if (readOnlyPipeline(String(args.command ?? ""))) return plan;
  markCommandAsk(args);
  return "ask";
}

/** The refusal for a call a block rule refused, or nothing for any other call. */
export function dozoCommandBlockRefusal(args: Record<string, unknown>): string | undefined {
  return commandBlocks.has(args)
    ? "This command is blocked for this bot. Don't run it or anything that does the same; tell the user it's blocked."
    : undefined;
}
