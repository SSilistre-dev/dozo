import type { DozoCliTool } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { queryClient, useQueryUserId } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";

/**
 * What the rest of the app reads of the tools below (the roster signal, the providers the key list
 * leaves out) without taking their screen with it, which loads when the settings open.
 *
 * Provider tools installed on the server's own computer, which the person can use as models with
 * their own sign-in, and more accounts of each through the tool's own sign-in. The server lists
 * none unless it runs on that computer for that person alone. Read again on the roster signal each
 * change and each sign-in step sends.
 */
const NONE: readonly DozoCliTool[] = [];
export const TOOLS_KEY = ["dozoCliAccounts"];

export function useCliTools(): readonly DozoCliTool[] {
  const tools = useQuery({
    queryKey: [...TOOLS_KEY, useQueryUserId()],
    queryFn: () => rpc.dozoCliAccounts.list(),
    refetchOnWindowFocus: "always",
  });
  return tools.data?.tools ?? NONE;
}

/** Reads the tools again; the roster signal carries a change. */
export function dozoCliAccountsChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: TOOLS_KEY });
}

/** The providers connected only from here, left out of the list that asks for a key. */
export function useDozoCliProviders(): ReadonlySet<string> {
  const tools = useCliTools();
  return useMemo(() => new Set(tools.map((tool) => tool.provider)), [tools]);
}
