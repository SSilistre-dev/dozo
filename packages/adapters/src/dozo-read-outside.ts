import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { RunContext, RunState } from "./run-context.js";
import { historyReplaysOutsideContent } from "./tool-step-calls.js";

/** Attempts, by their run state, whose model took in outside content. */
const readStates = new WeakSet<RunState>();

/** Outside content reached this attempt's model: every markReadOutsideContent call lands here. */
export function markRunReadOutside(state: RunState): void {
  readStates.add(state);
}

/** At assembly: history that replays a kept tool result shows the model outside content again. */
export function markHistoryReadOutside(state: RunState, history: AgentRunRequest["history"]) {
  if (historyReplaysOutsideContent(history)) readStates.add(state);
}

/**
 * Whether this run read outside content, whoever started it: isRunTainted without its "someone
 * other than the owner started the run" part, which says nothing about what the run read. Each of
 * isRunTainted's other sources counts:
 * - a result markReadOutsideContent marked: outside text reached the model;
 * - history replaying a kept tool result: the same text reaches it again;
 * - an earlier attempt: its restored turn may carry untrusted results, and nothing recorded what it
 *   read (the count is the one isRunTainted caches, so both make one query);
 * - an outside steering message the run took in: someone else's text reached the model.
 * A bot holding a token's text is not counted: that is where its input came from (runCameByToken).
 */
export async function runReadOutsideContent(
  ctx: Pick<RunContext, "deps" | "runId" | "state" | "trust">,
): Promise<boolean> {
  const { state } = ctx;
  if (readStates.has(state)) return true;
  state.earlierAttempt ??= ctx.deps.prisma.attempt
    .count({ where: { runId: ctx.runId } })
    .then((count) => count > 1);
  if ((await state.earlierAttempt) || (await ctx.trust.receivedOutsideMessage()))
    readStates.add(state);
  return readStates.has(state);
}
