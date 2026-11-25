import { useLingui } from "@lingui/react/macro";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useIdentityConfirmation } from "../../components/account/ConfirmIdentityDialog";
import { toastError } from "../../lib/dozo-error-text";
import { queryClient, useSave } from "../../lib/query/query";
import { markKey } from "./dozo-trust-bot";

/**
 * Trusts a bot again once, asking the person to confirm it is them when the server wants that, and
 * reads the bot's mark again. Loaded only when someone chose Trust this bot again.
 */
export function DozoTrustBotDialog(props: { botId: string; onDone: () => void }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Trust {...props} />
    </QueryClientProvider>
  );
}

function Trust({ botId, onDone }: { botId: string; onDone: () => void }) {
  const { t } = useLingui();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const trust = useSave({
    save: (id: string, rpc) =>
      withIdentityConfirmation(() => rpc.dozoAccessTokens.trustBot({ botId: id })),
    stale: (id) => [markKey(id)],
    onSaved: onDone,
    onFailed: (error) => {
      toastError(t`Could not trust the bot`, error);
      onDone();
    },
  });
  const started = useRef(false);
  const run = trust.run;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run(botId);
  }, [run, botId]);
  return identityDialog;
}
