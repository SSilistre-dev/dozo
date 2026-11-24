import type { DozoCommandComputer } from "@rakazo/core";
import {
  commandRuleCwd,
  matchCommandRules,
  readOnlyCwd,
  readOnlyPipeline,
  routineWriterIsOwner,
  runStartedFromOutside,
} from "@rakazo/core";
import { readDozoCommandRules, readDozoHostedAsks, readRoutineWriter } from "@rakazo/db";
import { runCameByToken } from "./dozo-token-run.js";
import { routineTaskInstructions } from "./routine-watch.js";
import type { RunContext } from "./run-context.js";
import { isRunTainted } from "./run-context.js";
import { commandWatchFromTool } from "./schedule-tools.js";
import { refusal } from "./tool-refusal.js";

/** The tool that runs a command on the bot's own computer. */
export const HOSTED_SHELL_TOOL = "shell";
/** The tool whose command watch runs a command on the bot's computer later, unattended. */
const SCHEDULE_TOOL = "schedule_create";
/** The tools that work the bot's own screen: computer_act's actions, and launch_app's program. */
const SCREEN_TOOLS = new Set(["computer_act", "launch_app"]);
/** computer_act's actions that only point, scroll or wait; any other one types or starts a program. */
const POINTER_ONLY_ACTIONS = new Set(["click", "move", "down", "up", "scroll", "wait"]);

/** Calls a block rule refused, so the refusal says why. */
const commandBlocks = new WeakSet<Record<string, unknown>>();
/** Each call's rule match, read once for the hold and the gate. */
const hostedMatches = new WeakMap<
  Record<string, unknown>,
  Promise<ReturnType<typeof matchCommandRules>>
>();
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
 * Why a command on the bot's computer needs approval, before upstream plans it: nothing for a
 * command that only reads, that a block rule refuses (the gate refuses it), or that an allow rule
 * of the member covers; otherwise the gate counts it as consequential, as upstream counts a tool
 * that changes something. `review` lets the approval model pass it in Auto review (told when the
 * run took in outside content: dozoHostedReviewFacts); `person` asks a person in every mode but
 * Never ask: in a run outside text started (dozoRunStartedFromOutside), or when the member asked
 * for commands on the bot's computer to ask. In a run that took in outside content (isRunTainted:
 * a page, a file, a command's output, a resumed turn, or a run the owner did not start, their
 * routine included) only an exact allow rule covers a command, not a prefix rule. An always-allow
 * rule for the tool and Never ask pass it, as upstream passes any consequential tool. Input on the
 * bot's screen is held the same way, by screenInputHold.
 */
export async function dozoHostedCommandHold(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
): Promise<"review" | "person" | undefined> {
  if (screenInputCall(name, args)) return screenInputHold(ctx);
  if (name !== HOSTED_SHELL_TOOL) return undefined;
  if (readOnlyCwd(args.cwd) && readOnlyPipeline(String(args.command ?? ""))) return undefined;
  const match = await hostedMatch(ctx, args);
  if (match === "block" || match === "allow") return undefined;
  if (match === "allow_prefix" && !(await isRunTainted(ctx))) return undefined;
  if (
    (await dozoRunStartedFromOutside(ctx)) ||
    (await readDozoHostedAsks(ctx.deps.prisma, ctx.run.userId))
  )
    return "person";
  return "review";
}

/**
 * Whether a call types text, presses a key or starts a program on the bot's screen (computer_act's
 * type, key and focus actions, or launch_app): in a terminal there, any of them can run a command.
 * The server cannot tell which window has the focus, so it never asks whether one is a terminal.
 * An action of a kind it does not know counts as input. Clicks, drags, scrolls and waits do not.
 */
function screenInputCall(name: string, args: Record<string, unknown>): boolean {
  if (!SCREEN_TOOLS.has(name)) return false;
  if (name !== "computer_act") return true;
  const actions: unknown[] = Array.isArray(args.actions) ? args.actions : [args.actions];
  return actions.some(
    (action) => !POINTER_ONLY_ACTIONS.has(String((action as { kind?: unknown } | null)?.kind)),
  );
}

/**
 * Input on the bot's screen runs as freely as before in the member's own run until outside content
 * comes in. A person is asked in a run outside text started (dozoRunStartedFromOutside), and once
 * the member asked for commands on the bot's computer to ask; any other run that took in outside
 * content (also one the owner did not start) has the approval model judge it, as a command is.
 */
async function screenInputHold(ctx: RunContext): Promise<"review" | "person" | undefined> {
  if (await dozoRunStartedFromOutside(ctx)) return "person";
  if (!(await isRunTainted(ctx))) return undefined;
  return (await readDozoHostedAsks(ctx.deps.prisma, ctx.run.userId)) ? "person" : "review";
}

/**
 * Whether text from someone other than the run's member started the run or reached it: a webhook
 * or email, a team chat's channel, a message sent with an access token, an outside message taken
 * in while it ran, or a routine runStartedFromOutside (dozo-lasting-write-approval.ts) counts as
 * outside: one a change trigger fired, whose prompt ends with what the watch read, or whose prompt
 * someone else last wrote. Two departures from that rule, so existing bots keep working: a routine
 * with no writer on record is taken as its owner's (it predates the record), and every other run
 * the owner did not start (another bot's message, a spawned bot, a ticket) goes to the approval
 * model, told its task is not the owner's words (dozoHostedReviewFacts), instead of a card.
 */
export async function dozoRunStartedFromOutside(ctx: RunContext): Promise<boolean> {
  const { run } = ctx;
  if (run.trigger === "webhook" || ctx.source.messagingChannelRun) return true;
  if ((await runCameByToken(ctx)) || (await ctx.trust.receivedOutsideMessage())) return true;
  if (run.trigger !== "routine") return false;
  return runStartedFromOutside(
    {
      trigger: run.trigger,
      ownerStartedRun: false,
      nonOwnerChatRun: false,
      watchFired: routineTaskInstructions(ctx.task.prompt) !== ctx.task.prompt,
      botOwnerRun: true,
      readHistory: false,
    },
    async () => {
      if (!run.routineId) return true;
      const writer = (await readRoutineWriter(ctx.deps.prisma, run.routineId))?.writer;
      return writer === undefined || routineWriterIsOwner(writer);
    },
  );
}

/**
 * What the approval model is told about a command on the bot's computer, or input on its screen
 * (screenInputCall): whether outside content came in, and whether the run's task is someone else's
 * text rather than the owner's words (a run the owner did not start, other than their own routine
 * or chat app).
 */
export async function dozoHostedReviewFacts(
  ctx: RunContext,
  name: string,
): Promise<{ outsideContent?: true; taskFromOutside?: true }> {
  if (name !== HOSTED_SHELL_TOOL && !SCREEN_TOOLS.has(name)) return {};
  const { trigger } = ctx.run;
  const ownersTask = ctx.source.ownerStartedRun || trigger === "routine" || trigger === "messaging";
  return {
    ...((await isRunTainted(ctx)) ? { outsideContent: true as const } : {}),
    ...(ownersTask ? {} : { taskFromOutside: true as const }),
  };
}

function hostedMatch(ctx: RunContext, args: Record<string, unknown>) {
  const known = hostedMatches.get(args);
  if (known) return known;
  const match = commandRuleMatch(ctx, args, "hosted");
  hostedMatches.set(args, match);
  return match;
}

/**
 * Upstream's plan for a command on the bot's computer, held first by dozoHostedCommandHold, then
 * the member's command rules. A block rule refuses it in every mode. An exact allow rule lets it go
 * ahead where upstream asks only because outside text started the run, as an always-allow rule for
 * the tool would; a prefix rule never does that, and a rule asking for the whole tool still asks.
 * A routine's command watch, which runs on the bot's computer later, is refused by a block rule
 * too; upstream asks about it in any other case. A run reached by a token's text is gated after
 * this (dozo-token-run.ts).
 */
export async function dozoHostedCommandGate<Plan extends string>(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  resolved: { decision: string; source?: string },
  plan: Plan,
): Promise<Plan | "deny" | "allow"> {
  if (plan === "deny") return plan;
  if (name === SCHEDULE_TOOL) {
    const command = commandWatchFromTool(args.watch);
    if (command === undefined || (await commandRuleMatch(ctx, { command }, "hosted")) !== "block")
      return plan;
    commandBlocks.add(args);
    return "deny";
  }
  if (name !== HOSTED_SHELL_TOOL) return plan;
  const match = await hostedMatch(ctx, args);
  if (match === "block") return "deny";
  if (plan === "allow") return plan;
  return match === "allow" && resolved.decision !== "ask" ? "allow" : plan;
}

/** The refusal for a call a block rule refused, or nothing for any other call. */
export function dozoCommandBlockRefusal(args: Record<string, unknown>): string | undefined {
  return commandBlocks.has(args)
    ? "This command is blocked for this bot. Don't run it or anything that does the same; tell the user it's blocked."
    : undefined;
}

/**
 * The answer for a call a block rule refused, after `audit` has recorded it, or nothing for any
 * other call or plan. The tool gate calls it where it would otherwise spell the same out.
 */
export async function dozoBlockedRefusal(
  plan: string,
  args: Record<string, unknown>,
  audit: () => Promise<unknown>,
): Promise<{ result: { error: string } } | undefined> {
  const message = plan === "deny" ? dozoCommandBlockRefusal(args) : undefined;
  if (message === undefined) return undefined;
  await audit();
  return { result: refusal("approval_denied", message) };
}
