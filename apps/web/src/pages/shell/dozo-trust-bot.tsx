import { useLingui } from "@lingui/react/macro";
import { ContextMenuItem } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import { useIdentityConfirmation } from "../../components/ConfirmIdentityDialog";
import { toastError } from "../../lib/dozo-error-text";
import { useSave } from "../../lib/query";
import type { createSpaceRpc } from "../../lib/rpc";

/** Where a bot's mark is read; trusting it again makes this read again. */
const markKey = (botId: string) => ["dozoBotMark", botId] as const;

/** The mounted host's way to start trusting a bot; the menu closes before the dialog opens. */
let requestTrust: ((botId: string) => void) | null = null;

export type DozoTrustBotItemProps = {
  rpc: ReturnType<typeof createSpaceRpc>;
  botId: string;
  onClose: () => void;
};

/**
 * In a bot's menu, only while it is marked by text sent with an access token (its runs ask before
 * acting): one item to trust it again. The host below asks the person to confirm it is them.
 */
export function DozoTrustBotItem({ rpc, botId, onClose }: DozoTrustBotItemProps) {
  const { t } = useLingui();
  const mark = useQuery({
    queryKey: markKey(botId),
    queryFn: () => rpc.dozoAccessTokens.botMark({ botId }),
  });
  if (!mark.data?.marked) return null;
  return (
    <ContextMenuItem
      onClick={() => {
        onClose();
        requestTrust?.(botId);
      }}
    >
      <ShieldCheck />
      {t`Trust this bot again`}
    </ContextMenuItem>
  );
}

/**
 * Mounted once beside the shell, so the identity check outlives the menu that asked for it.
 * Trusting is the owner's act from the app: the API a token reaches has no way to it.
 */
export function DozoTrustBotHost() {
  const { t } = useLingui();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const trust = useSave({
    save: (botId: string, rpc) =>
      withIdentityConfirmation(() => rpc.dozoAccessTokens.trustBot({ botId })),
    stale: (botId) => [markKey(botId)],
    onFailed: (error) => toastError(t`Could not trust the bot`, error),
  });
  const run = trust.run;
  useEffect(() => {
    requestTrust = run;
    return () => {
      if (requestTrust === run) requestTrust = null;
    };
  }, [run]);
  return identityDialog;
}
