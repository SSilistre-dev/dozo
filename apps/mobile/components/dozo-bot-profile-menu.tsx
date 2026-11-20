import { useLingui } from "@lingui/react/macro";
import { Alert } from "react-native";
import { shareChatMarkdown } from "../lib/dozo-chat-export";
import { errorText } from "../lib/user-error";
import type { BotProfileAction } from "./bot-profile-menu";
import { useBotProfileActions as useUpstreamBotProfileActions } from "./bot-profile-menu";

export { botProfileMenuOptions } from "./bot-profile-menu";

/** Upstream's profile actions with Export first, as the web roster menu has it. */
export function useBotProfileActions(botId: string, name: string): BotProfileAction[] {
  const { t } = useLingui();
  const actions = useUpstreamBotProfileActions(botId, name);
  return [
    {
      id: "export",
      text: t`Export`,
      onPress: () =>
        void shareChatMarkdown(botId, name).catch((error: unknown) =>
          Alert.alert(t`Could not export`, errorText(error, t`Try again.`)),
        ),
    },
    ...actions,
  ];
}
