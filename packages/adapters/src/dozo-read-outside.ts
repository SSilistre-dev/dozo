import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { RunContext, RunState } from "./runs/assembly/run-context.js";
import { historyReplaysOutsideContent } from "./runs/turn/tool-step-calls.js";

/** Attempts, by their run state, whose model took in outside content. */
const readStates = new WeakSet<RunState>();

/** Outside content reached this attempt's model: every markReadOutsideContent call lands here. */
export function markRunReadOutside(state: RunState): void {
  readStates.add(state);
}

/**
 * At assembly, the content sources initiallyTainted counts: history that replays a kept tool result
 * shows the model outside content again, and a saved turn it restores (or could not read) may carry
 * untrusted results.
 */
export function markAssemblyReadOutside(
  state: RunState,
  history: AgentRunRequest["history"],
  saved: { turnCheckpoint?: string; checkpointLoadError?: Error },
) {
  if (saved.turnCheckpoint || saved.checkpointLoadError || historyReplaysOutsideContent(history))
    readStates.add(state);
}

/** The tools that bring back the chat's earlier pages, or another chat's. */
const HISTORY_TOOLS = new Set(["read_history", "search_history"]);

/** Attempts, by their run state, that called a history tool. */
const historyStates = new WeakSet<RunState>();

/** Notes a call of a history tool, before it runs: a call that failed partway still counts. */
export function markRunReadHistory(state: RunState, toolName: string): void {
  if (HISTORY_TOOLS.has(toolName)) historyStates.add(state);
}

/**
 * Whether this attempt called read_history or search_history. Their results carry no mark (the
 * product's own saved state), yet a page an earlier run read comes back with them, so only the
 * lasting-write rule reads this; memory and retention do not.
 */
export function runReadHistory(state: RunState): boolean {
  return historyStates.has(state);
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
