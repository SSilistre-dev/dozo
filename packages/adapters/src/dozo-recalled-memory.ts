import type { AgentRunRequest } from "@rakazo/adapter-kit";

type History = AgentRunRequest["history"];

/**
 * The history a run sends: the compacted summary, the stored conversation, then the memory recalled
 * for this turn. Recall is searched with this turn's prompt and changes every turn, so it goes last,
 * next to the prompt: placed first it changed the start of the history, and every turn rewrote the
 * whole conversation to the prompt cache instead of reading it.
 */
export function historyWithRecall(summary: History, conversation: History, recalled: History) {
  return [...summary, ...conversation, ...recalled];
}
