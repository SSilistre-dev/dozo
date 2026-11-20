import { Share } from "react-native";
import { rpc } from "./api";

/**
 * The chat as Markdown, rendered by the server as the caller may read it, handed to the system
 * share sheet, which offers copying it and saving it to a file.
 */
export async function shareChatMarkdown(botId: string, name: string): Promise<void> {
  const { markdown } = await rpc("dozoChatExport/markdown", {
    botId,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  await Share.share({ message: markdown, title: name });
}
