import { useLingui } from "@lingui/react/macro";
import { useRouter } from "expo-router";
import { useDozoNewChat } from "../lib/dozo-bot-chats";
import { useChatExport } from "../lib/dozo-chat-export";
import { useDozoChatPins } from "../lib/dozo-message-actions";
import { useDozoTrustActions } from "../lib/dozo-trust-bot";
import type { BotProfileAction } from "./bot-profile-menu";
import { useBotProfileActions as useUpstreamBotProfileActions } from "./bot-profile-menu";

export { botProfileMenuOptions } from "./bot-profile-menu";

/**
 * Upstream's profile actions with New chat and Export first, as the web roster menu has them, then
 * Pinned while the chat has pinned messages, and Trust this bot again while the bot is marked.
 */
export function useBotProfileActions(botId: string, name: string): BotProfileAction[] {
  const { t } = useLingui();
  const router = useRouter();
  const actions = useUpstreamBotProfileActions(botId, name);
  const exportChat = useChatExport();
  const { threadId, pins } = useDozoChatPins({ botId });
  const trust = useDozoTrustActions(botId);
  const newChat = useDozoNewChat(botId, name);
  return [
    { id: "newChat", text: t`New chat`, onPress: () => newChat.run(undefined) },
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
    ...trust,
    ...actions,
  ];
}
