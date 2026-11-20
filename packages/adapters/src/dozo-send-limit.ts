import { takeDozoDailySend } from "@rakazo/db";
import type { buildApprovalAskBlock } from "./approval-ask.js";
import type { RunContext } from "./run-context.js";

/** Built-ins that send something to someone other than the owner. */
const SENDING_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["send_email", "message_agent"]);

/** Calls held for the daily limit, with the number the card names. */
const limitAsks = new WeakMap<Record<string, unknown>, number>();

/**
 * Upstream's plan for a call, then the account's daily sends: a send that would go ahead without
 * a person (allowed, or left to the approval model) is counted, and once this bot has made the
 * day's number of them, it asks instead. A send is a built-in that reaches someone else, or an app
 * action upstream counts as changing something. A call that already asks, is denied, or was
 * approved on its card is not counted.
 */
export async function dozoSendLimitGate<Plan extends string>(
  ctx: RunContext,
  call: {
    name: string;
    args: Record<string, unknown>;
    viaConnector: boolean;
    /** The connector call changes something, as upstream's gate judges it. */
    connectorChanges: boolean;
    approved: boolean;
  },
  plan: Plan,
): Promise<Plan | "ask"> {
  const sends = call.viaConnector ? call.connectorChanges : SENDING_BUILTIN_TOOLS.has(call.name);
  if (!sends || call.approved || (plan !== "allow" && plan !== "judge")) return plan;
  const taken = await takeDozoDailySend(ctx.deps.prisma, {
    userId: ctx.run.userId,
    botId: ctx.bot.id,
  });
  if (!taken.full) return plan;
  limitAsks.set(call.args, taken.dailySends);
  return "ask";
}

type CardOptions = NonNullable<Parameters<typeof buildApprovalAskBlock>[4]>;

/** The card of a send held for the limit says why, and offers no Always allow: it would not help. */
export function dozoSendLimitCard(
  args: Record<string, unknown>,
  options: CardOptions | undefined,
): CardOptions | undefined {
  const dailySends = limitAsks.get(args);
  if (dailySends === undefined) return options;
  return {
    ...options,
    onceOnly: true,
    reviewReason: `Daily limit reached: this bot made ${dailySends} sends today without asking.`,
  };
}
