import type { Bot } from "@rakazo/contracts";
import type { Query, QueryClient } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";

/** Whether a cached read is about this bot: its input names the bot. */
function readsBot(query: Query, botId: string) {
  const options = query.queryKey[1] as { input?: { botId?: unknown } } | undefined;
  return options?.input?.botId === botId;
}

/**
 * After a bot is deleted: drops it from the roster at once and forgets every read of it. The
 * deletion signals routines and runs to be read again, and until the roster is read again a read
 * still open for the bot (the composer's routine mentions) would ask for it and be refused.
 */
export function dozoForgetBot(
  client: QueryClient,
  setBots: Dispatch<SetStateAction<Bot[]>>,
  botId: string,
) {
  setBots((current) => current.filter((bot) => bot.id !== botId));
  const predicate = (query: Query) => readsBot(query, botId);
  void client.cancelQueries({ predicate });
  client.removeQueries({ predicate });
}
