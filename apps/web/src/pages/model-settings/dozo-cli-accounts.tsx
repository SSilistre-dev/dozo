import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoCliTool } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { SettingsRow } from "../../components/SettingsRows";
import { toastError } from "../../lib/dozo-error-text";
import { queryClient, useQueryUserId, useSave, useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";

/**
 * Provider tools installed on the server's own computer, which the person can use as models with
 * their own sign-in. The server lists none unless it runs on that computer for that person alone.
 * Read again on the roster signal a new connection sends.
 */
const NONE: readonly DozoCliTool[] = [];

function useCliTools(): readonly DozoCliTool[] {
  const tools = useQuery({
    queryKey: ["dozoCliAccounts", useQueryUserId()],
    queryFn: () => rpc.dozoCliAccounts.list(),
    refetchOnWindowFocus: "always",
  });
  return tools.data?.tools ?? NONE;
}

/** Reads the tools again; the roster signal carries a new connection. */
export function dozoCliAccountsChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: ["dozoCliAccounts"] });
}

/** The providers connected only from here, left out of the list that asks for a key. */
export function useDozoCliProviders(): ReadonlySet<string> {
  const tools = useCliTools();
  return useMemo(() => new Set(tools.map((tool) => tool.provider)), [tools]);
}

function CliToolRow({ tool }: { tool: DozoCliTool }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const save = useSave({
    save: (provider: string, rpc) => rpc.dozoCliAccounts.connect({ provider }),
    stale: [
      ["dozoCliAccounts"],
      queries.models.credentials.queryKey(),
      queries.models.list.queryKey(),
    ],
    onFailed: (error) => toastError(t`Could not connect`, error),
  });
  return (
    <SettingsRow
      label={tool.name}
      control={
        tool.signedIn === false ? (
          <span className="text-body-sm text-muted-foreground">
            <Trans>Not signed in</Trans>
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={save.pending}
            onClick={() => save.run(tool.provider)}
          >
            <Trans>Connect</Trans>
          </Button>
        )
      }
    />
  );
}

/** One row per installed tool not connected yet; nothing at all where there is none. */
export function DozoCliAccounts() {
  const tools = useCliTools().filter((tool) => tool.found && !tool.connected);
  if (!tools.length) return null;
  return (
    <div
      className="mt-3 divide-y divide-border rounded-xl border border-border"
      data-testid="dozo-cli-accounts"
    >
      {tools.map((tool) => (
        <CliToolRow key={tool.provider} tool={tool} />
      ))}
    </div>
  );
}
