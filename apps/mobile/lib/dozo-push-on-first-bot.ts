import { useEffect } from "react";
import { registerPushToken } from "./notifications/push";

/**
 * Asks for notifications once the account has a bot to be notified about, not on the first open
 * of an empty inbox. An anchored rule in app/index.tsx calls it in place of upstream's effect;
 * someone who already answered is not asked again.
 */
export function usePushWhenAccountHasBot(enabled: boolean, hasBot: boolean) {
  useEffect(() => {
    if (!enabled || !hasBot) return;
    void registerPushToken().catch(() => undefined);
  }, [enabled, hasBot]);
}
