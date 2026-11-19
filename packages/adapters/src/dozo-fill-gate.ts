import { loadRunTurnCheckpoint } from "@rakazo/db";
import type { RunContext } from "./run-context.js";
import { refusal } from "./tool-refusal.js";

/** Tools that start programs on the bot's computer, where the browser holds what a fill typed. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["shell", "launch_app", "open_path"]);
const FILL_KINDS: ReadonlySet<string> = new Set([
  "fill_secret",
  "fill_card",
  "fill_pay_token",
  "fill_code",
]);

export const FILL_GATE_MESSAGE =
  "Commands and apps are off for the rest of this run because it filled a saved login or card on a page. Finish the task in the browser.";

// Per attempt: whether the run has filled a page. Unknown until a fill or a command tool asks.
const filled = new WeakMap<RunContext["state"], boolean>();

function fillsPage(name: unknown, args: unknown): boolean {
  if (name !== "browser_act" || !args || typeof args !== "object") return false;
  const actions = (args as { actions?: unknown }).actions;
  return (
    Array.isArray(actions) &&
    actions.some(
      (action) =>
        Boolean(action) &&
        typeof action === "object" &&
        FILL_KINDS.has(String((action as { kind?: unknown }).kind)),
    )
  );
}

/** Whether the turn this run saved before a pause, resumed by this attempt, asked for a fill. */
async function savedTurnFilled(ctx: RunContext): Promise<boolean> {
  const blob = await loadRunTurnCheckpoint(ctx.deps.prisma, ctx.run);
  if (blob === undefined) return false;
  const { messages } = JSON.parse(blob) as { messages?: unknown };
  return (
    Array.isArray(messages) &&
    messages.some(
      (message: { role?: unknown; content?: unknown }) =>
        message?.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part: { type?: unknown; name?: unknown; arguments?: unknown }) =>
            part?.type === "toolCall" && fillsPage(part.name, part.arguments),
        ),
    )
  );
}

/**
 * Once a run asks the page browser to fill a saved login, card, code or pay token, it may not
 * start programs on that computer for the rest of the run. A run without a fill is unchanged.
 */
export async function fillGateRefusal(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ error: string } | undefined> {
  if (fillsPage(name, args)) {
    filled.set(ctx.state, true);
    return undefined;
  }
  if (!COMMAND_TOOLS.has(name)) return undefined;
  if (filled.get(ctx.state) === undefined) {
    const saved = await savedTurnFilled(ctx);
    // A fill this attempt started while the saved turn was read is kept.
    if (filled.get(ctx.state) === undefined) filled.set(ctx.state, saved);
  }
  return filled.get(ctx.state)
    ? refusal("page_fill_blocks_commands", FILL_GATE_MESSAGE)
    : undefined;
}
