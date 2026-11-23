import type { RunState } from "./run-context.js";

/** Attempts, by their run state, whose model was shown memory recalled for the turn. */
const recalledStates = new WeakSet<RunState>();

/** At assembly: memory recalled for this turn goes into the model's history. */
export function markRunRecalledMemory(state: RunState, recalledMemory: string): void {
  if (recalledMemory) recalledStates.add(state);
}

/** Whether this attempt's model was shown recalled memory. */
export function runRecalledMemory(state: RunState): boolean {
  return recalledStates.has(state);
}
