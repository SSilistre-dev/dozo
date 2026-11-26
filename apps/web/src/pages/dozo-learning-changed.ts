import { queryClient } from "../lib/query/query";

/** The reads a learning change makes out of date: the learned list, the bot's notes and budget. */
const LEARNING_READS = new Set(["dozoLearning.get", "memory.list", "memory.budget"]);

/**
 * A bot's learning review or an undo comes on the owner's roster signal: read the learned list and
 * the bot's memory again (an open panel only). Apart from the section, so the page's first code
 * holds this and not it.
 */
export function dozoLearningChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: ({ queryKey: [path, options] }) => {
      if (!Array.isArray(path) || !LEARNING_READS.has(path.slice(-2).join("."))) return false;
      const input = (options as { input?: { botId?: unknown } } | undefined)?.input;
      return typeof input?.botId === "string";
    },
  });
}
