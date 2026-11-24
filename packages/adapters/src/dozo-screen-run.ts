import type { MessageBlock } from "@rakazo/contracts";
import type { ApprovalMode } from "@rakazo/core";
import { storedMessageBlocks } from "@rakazo/db";
import { screenInputCall } from "./dozo-command-gate.js";
import type { RunContext, RunState } from "./run-context.js";

/**
 * The answer on a card for input on the bot's screen that sends the rest of this run's screen
 * input to the approval model, as Auto review would. Owner-only, checked where answers are saved
 * (dozo/brand/brand.json, packages/db/src/thread-ask.ts).
 */
export const SCREEN_RUN_ALLOW = "allow_run";

/** Eligible calls not yet allowed for the run: asked in Ask, the card deciding whether to offer it. */
const pending = new WeakSet<Record<string, unknown>>();
/** Calls whose card offers SCREEN_RUN_ALLOW: pending ones a model the gate would run could judge. */
const offered = new WeakSet<Record<string, unknown>>();
/** Whether the run's member gave SCREEN_RUN_ALLOW in this run, read once per attempt. */
const granted = new WeakMap<RunState, Promise<boolean>>();

/**
 * The approval mode for one call. In Ask, input on the bot's screen the approval model would judge
 * in Auto review (hold `review`: a run of the member's own message that took in outside content)
 * is planned as in Auto review, so the gate works out whether a model would judge it. Once the
 * member allowed it for this run it then goes to that model, and still asks when the model asks,
 * fails or there is none; until then dozoScreenRunChecker keeps it asking. Runs outside text
 * started, a token's run, other triggers, commands, Never ask and Auto are unchanged.
 */
export async function dozoScreenRunMode(
  ctx: RunContext,
  call: {
    name: string;
    args: Record<string, unknown>;
    hold: string | undefined;
    /** The call a person just approved, replayed: it runs as approved, never reviewed again. */
    approved: boolean;
  },
  mode: ApprovalMode,
): Promise<ApprovalMode> {
  if (mode !== "ask" || call.hold !== "review" || call.approved) return mode;
  if (!ctx.source.ownerStartedRun) return mode;
  if (!screenInputCall(call.name, call.args)) return mode;
  if (!(await screenRunGranted(ctx))) pending.add(call.args);
  return "auto";
}

/**
 * Whether the gate plans the call for review: its own answer (checkerConfigured), except for a call
 * not yet allowed for the run, which asks as Ask does; its card offers Allow for this run only when
 * that answer says a model would judge the rest, so the button never leads to cards alone.
 */
export function dozoScreenRunChecker(
  args: Record<string, unknown>,
  checkerConfigured: boolean,
): boolean {
  if (!pending.has(args)) return checkerConfigured;
  if (checkerConfigured) offered.add(args);
  return false;
}

/** The card for a call offered SCREEN_RUN_ALLOW gets it after Allow once; any other card is as built. */
export function dozoScreenRunAsk(args: Record<string, unknown>, block: MessageBlock): MessageBlock {
  if (!offered.has(args) || block.kind !== "ask" || !block.actions) return block;
  const at = block.actions.findIndex((action) => action.id === "allow") + 1;
  return {
    ...block,
    actions: [
      ...block.actions.slice(0, at),
      { id: SCREEN_RUN_ALLOW, label: "Allow for this run" },
      ...block.actions.slice(at),
    ],
  };
}

/** A card of this run the member answered with SCREEN_RUN_ALLOW: the run's own cards are its messages. */
function screenRunGranted(ctx: RunContext): Promise<boolean> {
  let known = granted.get(ctx.state);
  if (!known) {
    known = ctx.deps.prisma.message
      .findMany({ where: { runId: ctx.runId, role: "bot" }, select: { id: true, blocks: true } })
      .then((messages) =>
        messages.some((message) =>
          storedMessageBlocks(message).some(
            (block) =>
              block.kind === "ask" &&
              block.status === "answered" &&
              block.answer === SCREEN_RUN_ALLOW,
          ),
        ),
      );
    granted.set(ctx.state, known);
  }
  return known;
}
