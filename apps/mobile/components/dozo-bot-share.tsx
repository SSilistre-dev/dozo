import { useLingui } from "@lingui/react/macro";
import { useRouter } from "expo-router";
import { rpcQuery } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import type { BotProfileAction } from "./bots/bot-profile-menu";

export const botShareStatusRead = (botId: string) => rpcQuery("dozoBotShares/status", { botId });

/** The profile menu's share action, only for a bot the person owns (the status read is refused otherwise). */
export function useDozoBotShareActions(botId: string, name: string): BotProfileAction[] {
  const { t } = useLingui();
  const router = useRouter();
  const status = useScreenQuery(botShareStatusRead(botId));
  if (status.isError || !status.data) return [];
  return [
    {
      id: "shareBot",
      text: t`Share link`,
      onPress: () => router.push({ pathname: "/dozo-bot-share", params: { botId, name } }),
    },
  ];
}
