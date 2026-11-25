import { useLingui } from "@lingui/react/macro";
import { ContextMenuItem } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { createSpaceRpc } from "../../lib/query/rpc";

/** Where a bot's mark is read; trusting it again makes this read again. */
export const markKey = (botId: string) => ["dozoBotMark", botId] as const;

/** The mounted host's way to start trusting a bot; the menu closes before the dialog opens. */
let requestTrust: ((botId: string | null) => void) | null = null;

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

const TrustDialog = lazy(() =>
  import("./dozo-trust-bot-dialog").then((module) => ({ default: module.DozoTrustBotDialog })),
);

/**
 * Mounted once beside the shell, so the identity check outlives the menu that asked for it. Holds
 * only which bot to trust; the check and the save load when someone asks. Trusting is the owner's
 * act from the app: the API a token reaches has no way to it.
 */
export function DozoTrustBotHost() {
  const [botId, setBotId] = useState<string | null>(null);
  useEffect(() => {
    requestTrust = setBotId;
    return () => {
      if (requestTrust === setBotId) requestTrust = null;
    };
  }, []);
  if (!botId) return null;
  return (
    <Suspense fallback={null}>
      <TrustDialog key={botId} botId={botId} onDone={() => setBotId(null)} />
    </Suspense>
  );
}
