import type { Routine } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { SpaceQueries } from "../../lib/query/query";

/**
 * Keeps the panel's routine list in step with the routines read. The list is shell state that only
 * the shell's own refreshes fill, so a routine another row changes, or another device, stayed
 * as it was until the chat was read again. Whenever the read for the open bot lands new data
 * (after a save names it stale, or on the Space's routines signal), the list takes it.
 */
export function useDozoRoutineSync(
  queries: SpaceQueries,
  botId: string | undefined,
  listedBotId: string | null,
  setRoutines: (routines: Routine[]) => void,
) {
  const read = useQuery({
    ...queries.routines.list.queryOptions({ input: { botId: botId ?? "" } }),
    enabled: botId !== undefined,
  }).data;
  useEffect(() => {
    // Only a list already showing this bot's routines, so one bot's never lands under another's.
    if (read && botId !== undefined && listedBotId === botId) setRoutines(read);
  }, [read, botId, listedBotId, setRoutines]);
}
