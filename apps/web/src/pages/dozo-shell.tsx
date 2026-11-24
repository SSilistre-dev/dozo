import { useEffect } from "react";
import { authClient } from "../lib/auth";
import { reportSignupStarted } from "../lib/dozo-events";
import { ShellPage as UpstreamShellPage } from "./Shell";
import { DozoChatAddress, useDozoOpenChat } from "./shell/dozo-bot-chats";
import { DozoTrustBotHost } from "./shell/dozo-trust-bot";

/**
 * Upstream's app shell, with the Trust bot's host beside it, a bot's extra chat opened from its
 * address, and the sign-up form this browser opened reported once for the account now signed in.
 */
export function ShellPage() {
  const userId = authClient.useSession().data?.user.id;
  useEffect(() => {
    if (userId) reportSignupStarted();
  }, [userId]);
  // A bot's extra chat is its own shell: switching chats starts the shell's hooks afresh.
  const chatId = useDozoOpenChat();
  const shell = (
    <>
      <UpstreamShellPage key={chatId ?? ""} />
      <DozoTrustBotHost />
    </>
  );
  return chatId ? <DozoChatAddress chatId={chatId}>{shell}</DozoChatAddress> : shell;
}
