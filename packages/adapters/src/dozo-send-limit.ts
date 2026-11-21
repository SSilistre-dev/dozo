import { takeDozoDailySend } from "@rakazo/db";
import type { buildApprovalAskBlock } from "./approval-ask.js";
import type { RunContext } from "./run-context.js";

/** Built-ins that send something to someone other than the owner. */
const SENDING_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["send_email", "message_agent"]);

/** The page tool whose presses can send what was put into a page. */
const PAGE_ACT_TOOL = "browser_act";
/** browser_act steps that put something of the bot's into the page: text, a choice, a file. */
const ENTRY_STEPS: ReadonlySet<string> = new Set(["fill", "type", "upload"]);
/**
 * Steps that sign in or enter a code. A press after them signs in, which is not a send for the
 * person; a saved card or pay token is a purchase, which its own card approves each time.
 */
const SIGN_IN_STEPS: ReadonlySet<string> = new Set(["fill_secret", "fill_code"]);

type PageStep = { kind?: unknown; text?: unknown };

const stepsOf = (args: Record<string, unknown>): PageStep[] =>
  Array.isArray(args.actions)
    ? args.actions.map((step) => (step && typeof step === "object" ? (step as PageStep) : {}))
    : [];

/** A press that can send what the page holds: a click, or text typed with a line break (Enter). */
const presses = (step: PageStep) =>
  step.kind === "click" || (step.kind === "type" && /[\r\n]/.test(String(step.text ?? "")));

/** Input the bot put into the page it is on and has not sent yet. */
export type PendingInput = { held: boolean; signIn: boolean };

/**
 * The sends a run of browser_act steps makes on one page: each press that follows input the bot
 * put in and has not sent counts one and sends it. A press on a page where the bot signed in or
 * typed a code is a sign-in and counts nothing. A press with nothing put in since the last one
 * (following a link, opening a menu) never counts.
 */
export function pageSends(
  steps: readonly PageStep[],
  before: PendingInput,
): { sends: number; after: PendingInput } {
  let sends = 0;
  let { held, signIn } = before;
  for (const step of steps) {
    if (typeof step.kind === "string" && SIGN_IN_STEPS.has(step.kind)) signIn = true;
    // Typed text with a line break is both: it goes in, and Enter sends it.
    if (typeof step.kind === "string" && ENTRY_STEPS.has(step.kind)) held = true;
    if (presses(step) && held) {
      if (!signIn) sends++;
      held = false;
      signIn = false;
    }
  }
  return { sends, after: { held, signIn } };
}

/** Input left unsent on a page, per run, with the address of that page. */
const unsent = new WeakMap<RunContext, PendingInput & { url: string | undefined }>();

/**
 * The sends of one browser_act call. Input an earlier call left unsent still counts only while the
 * page is the same one (the run's last known address): navigating, or a press that moved the page
 * on, drops it. Kept in this process for the run; a resumed run starts with none.
 */
function pageActSends(ctx: RunContext, args: Record<string, unknown>): number {
  const url = ctx.state.pageUrl;
  const kept = unsent.get(ctx);
  const before = kept && kept.url === url ? kept : { held: false, signIn: false };
  const { sends, after } = pageSends(stepsOf(args), before);
  if (after.held) unsent.set(ctx, { ...after, url });
  else unsent.delete(ctx);
  return sends;
}

/**
 * Upstream's plan for a call, then the account's daily sends: the sends of a call that would go
 * ahead without a person (allowed, or left to the approval model) are counted, and once they would
 * take this bot past the day's number, it asks instead. A send is a built-in that reaches someone
 * else, an app action upstream counts as changing something (each one in a batch), or a press on a
 * page that sends what the bot put into it there (pageSends). A call that already asks, is denied, or was
 * approved on its card is not counted.
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
    : call.name === PAGE_ACT_TOOL
      ? pageActSends(ctx, call.args)
      : Number(SENDING_BUILTIN_TOOLS.has(call.name));
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
