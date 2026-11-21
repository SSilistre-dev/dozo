import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoCliTool } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { SettingsRow } from "../../components/SettingsRows";
import { toastError } from "../../lib/dozo-error-text";
import { queryClient, useQueryUserId, useSave, useSpaceQueries } from "../../lib/query";
import type { RpcClient } from "../../lib/rpc";
import { rpc } from "../../lib/rpc";

/**
 * Provider tools installed on the server's own computer, which the person can use as models with
 * their own sign-in, and more accounts of each through the tool's own sign-in. The server lists
 * none unless it runs on that computer for that person alone. Read again on the roster signal each
 * change and each sign-in step sends.
 */
const NONE: readonly DozoCliTool[] = [];
const TOOLS_KEY = ["dozoCliAccounts"];

function useCliTools(): readonly DozoCliTool[] {
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

/** One action on a tool, saved through the server; a failure says what it could not do. */
function useToolAction(
  save: (provider: string, rpc: RpcClient) => Promise<unknown>,
  failed: string,
) {
  const queries = useSpaceQueries();
  return useSave({
    save,
    stale: [TOOLS_KEY, queries.models.credentials.queryKey(), queries.models.list.queryKey()],
    onFailed: (error) => toastError(failed, error),
  });
}

/** The tool's own sign-in of another account: its address, a code it asks for, or why it ended. */
function LoginSteps({ tool }: { tool: DozoCliTool }) {
  const { t } = useLingui();
  const [code, setCode] = useState("");
  const send = useToolAction(
    (provider, rpc) => rpc.dozoCliAccounts.sendCode({ provider, code }),
    t`Could not send the code`,
  );
  const cancel = useToolAction(
    (provider, rpc) => rpc.dozoCliAccounts.cancelLogin({ provider }),
    t`Could not cancel`,
  );
  if (tool.login?.status === "failed")
    return <p className="mt-2 text-body-sm text-muted-foreground">{tool.login.error}</p>;
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        send.run(tool.provider);
      }}
    >
      {tool.login?.url ? (
        <a
          className="text-body-sm text-foreground underline underline-offset-4"
          href={tool.login.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Trans>Open sign-in page</Trans>
        </a>
      ) : null}
      <Input
        aria-label={t`Code`}
        placeholder={t`Code`}
        className="h-8 w-40"
        value={code}
        onChange={(event) => setCode(event.target.value)}
      />
      <Button size="sm" variant="outline" type="submit" disabled={send.pending || !code.trim()}>
        <Trans>Send</Trans>
      </Button>
      <Button
        size="sm"
        variant="text"
        disabled={cancel.pending}
        onClick={() => cancel.run(tool.provider)}
      >
        <Trans>Cancel</Trans>
      </Button>
    </form>
  );
}

function CliToolRow({ tool }: { tool: DozoCliTool }) {
  const { t } = useLingui();
  const connect = useToolAction(
    (provider, rpc) => rpc.dozoCliAccounts.connect({ provider }),
    t`Could not connect`,
  );
  const add = useToolAction(
    (provider, rpc) => rpc.dozoCliAccounts.addAccount({ provider }),
    t`Could not add the account`,
  );
  return (
    <SettingsRow
      label={tool.name}
      control={
        <>
          {tool.connected ? null : tool.signedIn === false ? (
            <span className="text-body-sm text-muted-foreground">
              <Trans>Not signed in</Trans>
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={connect.pending}
              onClick={() => connect.run(tool.provider)}
            >
              <Trans>Connect</Trans>
            </Button>
          )}
          {tool.canAdd && tool.login?.status !== "waiting" ? (
            <Button
              size="sm"
              variant="text"
              disabled={add.pending}
              onClick={() => add.run(tool.provider)}
            >
              <Trans>Add account</Trans>
            </Button>
          ) : null}
        </>
      }
    >
      {tool.login ? <LoginSteps tool={tool} /> : null}
    </SettingsRow>
  );
}

/** One row per installed tool with something to do; nothing at all where there is none. */
export function DozoCliAccounts() {
  const tools = useCliTools().filter(
    (tool) => tool.found && (!tool.connected || tool.canAdd || tool.login),
  );
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
