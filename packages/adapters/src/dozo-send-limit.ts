import { takeDozoDailySend } from "@rakazo/db";
import type { buildApprovalAskBlock } from "./approvals/approval-ask.js";
import { dozoPageSubmits } from "./dozo-page-submit-gate.js";
import type { RunContext } from "./runs/assembly/run-context.js";

/** Built-ins that send something to someone other than the owner. */
const SENDING_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["send_email", "message_agent"]);

/** Calls held for the daily limit, with the number the card names. */
const limitAsks = new WeakMap<Record<string, unknown>, number>();

/**
 * Upstream's plan for a call, then the account's daily sends: the sends of a call that would go
 * ahead without a person (allowed, or left to the approval model) are counted, and once they would
 * take this bot past the day's number, it asks instead. A send is a built-in that reaches someone
 * else, an app action upstream counts as changing something (each one in a batch), or a form submit
 * made through the page browser (each one in a batch; `dozo-page-submit.ts` says what is one). A call
 * that already asks, is denied, or was approved on its card is not counted.
 */
export async function dozoSendLimitGate<Plan extends string>(
  ctx: RunContext,
  call: {
    name: string;
    args: Record<string, unknown>;
    viaConnector: boolean;
    /** The actions of a connector call that change something, as upstream's gate judges them. */
    connectorChanges: number;
    approved: boolean;
  },
  plan: Plan,
): Promise<Plan | "ask"> {
  if (call.approved || (plan !== "allow" && plan !== "judge")) return plan;
  const sends = call.viaConnector
    ? call.connectorChanges
    : SENDING_BUILTIN_TOOLS.has(call.name)
      ? 1
      : await dozoPageSubmits(ctx, call.name, call.args);
  if (sends < 1) return plan;
  const taken = await takeDozoDailySend(ctx.deps.prisma, {
    userId: ctx.run.userId,
    botId: ctx.bot.id,
    sends,
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
    reviewReason: `Over the daily limit: this bot may make ${dailySends} sends a day without asking.`,
  };
}

/** Whether the call asks only because it would pass the daily limit. */
export function dozoSendLimitHeld(args: Record<string, unknown>): boolean {
  return limitAsks.has(args);
}
