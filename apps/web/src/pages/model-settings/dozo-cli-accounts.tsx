import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoCliTool } from "@rakazo/contracts";
import { Button, Checkbox, Input } from "@rakazo/ui-web";
import { useState } from "react";
import { SettingsRow } from "../../components/SettingsRows";
import { toastError } from "../../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../../lib/query";
import type { RpcClient } from "../../lib/rpc";
import { rpc } from "../../lib/rpc";
import { TOOLS_KEY, useCliTools } from "./dozo-cli-providers";

export { dozoCliAccountsChanged, useDozoCliProviders } from "./dozo-cli-providers";

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

/**
 * What agent mode means, said once before an agent is connected: the person agrees to it, or the
 * agent is not connected.
 */
function AgentConsent({
  termsRisk,
  onAgree,
  onCancel,
  pending,
}: {
  termsRisk: boolean;
  onAgree: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const { t } = useLingui();
  const [riskAccepted, setRiskAccepted] = useState(false);
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="dozo-agent-consent">
      <p className="text-body-sm text-muted-foreground">
        <Trans>
          In agent mode the bot works as you, with everything you can reach. Dozo can show and stop
          only what the agent asks about or runs through Dozo; reading files and the agent's own web
          access can happen without asking.
        </Trans>
      </p>
      {termsRisk ? (
        <div className="flex items-start gap-2 text-body-sm text-foreground">
          <Checkbox
            checked={riskAccepted}
            aria-label={t`I accept this risk`}
            onCheckedChange={(checked) => setRiskAccepted(checked === true)}
          />
          <Trans>
            Its maker's terms count using this sign-in outside their own products as a reason to
            close your account. I accept this risk.
          </Trans>
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending || (termsRisk && !riskAccepted)}
          onClick={onAgree}
        >
          <Trans>I agree, connect</Trans>
        </Button>
        <Button size="sm" variant="text" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}

/** The maker's own page for an agent that is not installed: the one thing the row can do. */
function DownloadLink({ href }: { href: string }) {
  return (
    <a
      className="text-body-sm text-muted-foreground underline underline-offset-2"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      <Trans>Download</Trans>
    </a>
  );
}

function CliToolRow({ tool }: { tool: DozoCliTool }) {
  const { t } = useLingui();
  const agent = tool.mode === "agent";
  const [asking, setAsking] = useState(false);
  const connect = useToolAction(
    (provider, rpc) =>
      rpc.dozoCliAccounts.connect({
        provider,
        ...(agent ? { consent: true } : {}),
        ...(tool.termsRisk ? { termsConsent: true } : {}),
      }),
    t`Could not connect`,
  );
  const add = useToolAction(
    (provider, rpc) => rpc.dozoCliAccounts.addAccount({ provider }),
    t`Could not add the account`,
  );
  return (
    <SettingsRow
      label={
        agent ? (
          <span className="flex items-center gap-2">
            {tool.name}
            <span className="rounded-full border border-border px-2 text-body-sm text-muted-foreground">
              <Trans>Agent</Trans>
            </span>
          </span>
        ) : (
          tool.name
        )
      }
      control={
        <>
          {tool.downloadUrl ? <DownloadLink href={tool.downloadUrl} /> : null}
          {tool.connected || asking || !tool.found ? null : tool.signedIn === false ? (
            <span className="text-body-sm text-muted-foreground">
              <Trans>Not signed in</Trans>
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={connect.pending}
              onClick={() => (agent ? setAsking(true) : connect.run(tool.provider))}
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
      {asking && !tool.connected ? (
        <AgentConsent
          termsRisk={tool.termsRisk === true}
          pending={connect.pending}
          onAgree={() => connect.run(tool.provider)}
          onCancel={() => setAsking(false)}
        />
      ) : null}
      {tool.login ? <LoginSteps tool={tool} /> : null}
    </SettingsRow>
  );
}

/**
 * One row per installed tool with something to do, and one per agent that is not installed, with
 * its maker's page; nothing at all where there is none.
 */
export function DozoCliAccounts() {
  const tools = useCliTools().filter((tool) =>
    tool.found ? !tool.connected || tool.canAdd || tool.login : tool.downloadUrl,
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
