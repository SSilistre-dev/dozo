import {
  JsonColumnMismatchError,
  readJsonColumn,
  reportJsonColumnOnce,
  takeDozoDailySend,
} from "@rakazo/db";
import { z } from "zod";
import type { buildApprovalAskBlock } from "./approval-ask.js";
import type { RunContext } from "./run-context.js";

/** Built-ins that send something to someone other than the owner. */
const SENDING_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["send_email", "message_agent"]);

/** The page tool whose presses can send what was put into a page. */
const PAGE_ACT_TOOL = "browser_act";
/** browser_act steps that put something into the page: text, a choice, a file or a saved value. */
const ENTRY_STEPS: ReadonlySet<string> = new Set([
  "fill",
  "type",
  "upload",
  "fill_secret",
  "fill_card",
  "fill_code",
  "fill_pay_token",
]);

type PageStep = { kind?: unknown; text?: unknown };

const stepsOf = (args: Record<string, unknown>): PageStep[] =>
  Array.isArray(args.actions)
    ? args.actions.map((step) => (step && typeof step === "object" ? (step as PageStep) : {}))
    : [];

/** A press that can send what the page holds: a click, or text typed with a line break (Enter). */
const presses = (step: PageStep) =>
  step.kind === "click" || (step.kind === "type" && /[\r\n]/.test(String(step.text ?? "")));

/**
 * The sends a run of browser_act steps makes: each press that follows input not sent yet counts
 * one and sends that input. `pending` is whether the page held such input before the steps.
 * Navigating, reading, and a press with nothing put in since the last one never count.
 */
export function pageSends(
  steps: readonly PageStep[],
  pending: boolean,
): { sends: number; pending: boolean } {
  let sends = 0;
  let held = pending;
  for (const step of steps) {
    // Typed text with a line break is both: it goes in, and Enter sends it.
    if (typeof step.kind === "string" && ENTRY_STEPS.has(step.kind)) held = true;
    if (presses(step) && held) {
      sends++;
      held = false;
    }
  }
  return { sends, pending: held };
}

const StoredPageAct = z.object({ actions: z.array(z.object({}).passthrough()) });

/**
 * The sends of one browser_act call. Whether the page already held input not sent is read from
 * this run's earlier browser_act calls that were not denied, in order, and only when a press in
 * this call comes before anything it puts in. A stored call of another shape is left out and
 * reported.
 */
async function pageActSends(ctx: RunContext, args: Record<string, unknown>): Promise<number> {
  const steps = stepsOf(args);
  const firstPress = steps.findIndex(presses);
  if (firstPress < 0) return 0;
  const firstEntry = steps.findIndex(
    (step) => typeof step.kind === "string" && ENTRY_STEPS.has(step.kind),
  );
  let pending = false;
  if (firstEntry < 0 || firstPress < firstEntry) {
    const earlier = await ctx.deps.prisma.externalEffect.findMany({
      where: { runId: ctx.runId, kind: PAGE_ACT_TOOL, status: { not: "denied" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, request: true },
    });
    for (const effect of earlier) {
      const row = { table: "external_effects", column: "request", id: effect.id };
      try {
        const stored = readJsonColumn(StoredPageAct, effect.request, row, "reject");
        pending = pageSends(stepsOf(stored), pending).pending;
      } catch (error) {
        if (!(error instanceof JsonColumnMismatchError)) throw error;
        reportJsonColumnOnce("browser_act request left out of the daily send count", row);
      }
    }
  }
  return pageSends(steps, pending).sends;
}

/** Calls held for the daily limit, with the number the card names. */
const limitAsks = new WeakMap<Record<string, unknown>, number>();

/**
 * Upstream's plan for a call, then the account's daily sends: the sends of a call that would go
 * ahead without a person (allowed, or left to the approval model) are counted, and once they would
 * take this bot past the day's number, it asks instead. A send is a built-in that reaches someone
 * else, an app action upstream counts as changing something (each one in a batch), or a press on a
 * page that sends what the bot put into it (pageSends). A call that already asks, is denied, or was
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
      ? await pageActSends(ctx, call.args)
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
