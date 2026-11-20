import { useLingui } from "@lingui/react/macro";
import type { ChatExportRange } from "@rakazo/contracts";
import { chatExportSince } from "@rakazo/contracts";
import { Alert, Share } from "react-native";
import { rpc } from "./api";
import { resolveMobileAppearance } from "./appearance";
import { presentMessageActionSheet } from "./message-action-sheet";
import { errorText } from "./user-error";

export type ChatExportTarget = { botId: string } | { groupId: string };

/**
 * The chat as Markdown, rendered by the server as the caller may read it, handed to the system
 * share sheet, which offers copying it and saving it to a file. True when the server left the
 * earliest messages out to stay within its size limit.
 */
export async function shareChatMarkdown(
  target: ChatExportTarget,
  name: string,
  range: ChatExportRange,
): Promise<boolean> {
  const { markdown, truncated } = await rpc("dozoChatExport/markdown", {
    ...target,
    since: chatExportSince(range, new Date()),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  await Share.share({ message: markdown, title: name });
  return truncated;
}

/** Export: asks how far back, as the web menu does, then shares the chat. */
export function useChatExport(): (target: ChatExportTarget, name: string) => void {
  const { t } = useLingui();
  const share = (target: ChatExportTarget, name: string, range: ChatExportRange) =>
    void shareChatMarkdown(target, name, range).then(
      (truncated) => {
        if (truncated) Alert.alert(t`Earlier messages were left out`);
      },
      (error: unknown) => Alert.alert(t`Could not export`, errorText(error, t`Try again.`)),
    );
  return (target, name) => {
    const ranges: [ChatExportRange, string][] = [
      ["all", t`Whole chat`],
      ["today", t`Today`],
      ["week", t`Last 7 days`],
      ["month", t`Last 30 days`],
    ];
    presentMessageActionSheet({
      title: t`Export`,
      cancel: t`Cancel`,
      more: t`More`,
      colorScheme: resolveMobileAppearance(),
      actions: ranges.map(([range, text]) => ({ text, onPress: () => share(target, name, range) })),
    });
  };
}
