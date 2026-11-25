import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import type { BotProfileAction } from "../components/bots/bot-profile-menu";
import { useIdentityConfirmation } from "../components/vault/confirm-identity";
import { queryClient, rpcQuery, useSave } from "./query/query";
import { errorText } from "./user-error";

/** Where a bot's mark is read; trusting it again reads this again. */
const markRead = (botId: string) => rpcQuery("dozoAccessTokens/botMark", { botId });

/** The mounted host's way to start trusting a bot; the menu has closed before the check opens. */
let requestTrust: ((botId: string) => void) | null = null;

/**
 * The profile menu's item, only while the bot is marked by text sent with an access token (its
 * runs ask before acting): one item to trust it again, after asking. Choosing it hands the bot to
 * the host below, which asks the person to confirm it is them.
 */
export function useDozoTrustActions(botId: string): BotProfileAction[] {
  const { t } = useLingui();
  const mark = useQuery({ ...markRead(botId), enabled: Boolean(botId) }, queryClient);
  if (!mark.data?.marked) return [];
  return [
    {
      id: "trust",
      text: t`Trust this bot again`,
      onPress: () =>
        Alert.alert(t`Trust this bot again`, undefined, [
          { text: t`Cancel`, style: "cancel" },
          { text: t`Continue`, onPress: () => requestTrust?.(botId) },
        ]),
    },
  ];
}

/**
 * Mounted once on the profile, so the identity check outlives the menu that asked for it. Holds
 * only which bot to trust; the check and the save exist only while someone is trusting a bot.
 * Trusting is the owner's act from the app: the API a token reaches has no way to it.
 */
export function DozoTrustBotHost() {
  const [botId, setBotId] = useState<string | null>(null);
  useEffect(() => {
    requestTrust = setBotId;
    return () => {
      if (requestTrust === setBotId) requestTrust = null;
    };
  }, []);
  return botId ? <Trust key={botId} botId={botId} onDone={() => setBotId(null)} /> : null;
}

function Trust({ botId, onDone }: { botId: string; onDone: () => void }) {
  const { t } = useLingui();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const trust = useSave({
    save: (id: string, send) =>
      withIdentityConfirmation(() => send("dozoAccessTokens/trustBot", { botId: id })),
    stale: [markRead(botId).queryKey],
    onSaved: onDone,
    onFailed: (error) => {
      Alert.alert(t`Could not trust the bot`, errorText(error, t`Try again.`));
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
