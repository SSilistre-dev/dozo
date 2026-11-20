import { useLingui } from "@lingui/react/macro";
import { useRouter } from "expo-router";
import { useChatExport } from "../lib/dozo-chat-export";
import { useDozoChatPins } from "../lib/dozo-message-actions";
import type { BotProfileAction } from "./bot-profile-menu";
import { useBotProfileActions as useUpstreamBotProfileActions } from "./bot-profile-menu";

export { botProfileMenuOptions } from "./bot-profile-menu";

/**
 * Upstream's profile actions with Export first, as the web roster menu has it, then Pinned while
 * the chat has pinned messages.
 */
export function useBotProfileActions(botId: string, name: string): BotProfileAction[] {
  const { t } = useLingui();
  const router = useRouter();
  const actions = useUpstreamBotProfileActions(botId, name);
  const exportChat = useChatExport();
  const { threadId, pins } = useDozoChatPins({ botId });
  return [
    { id: "export", text: t`Export`, onPress: () => exportChat({ botId }, name) },
    ...(threadId && pins?.length
      ? [
          {
            id: "pinned",
            text: t`Pinned`,
            onPress: () =>
              router.push({ pathname: "/dozo-pins", params: { threadId, botId, name } }),
          },
        ]
      : []),
    ...actions,
  ];
}
