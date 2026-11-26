import { bestEffort } from "@rakazo/logging/best-effort";
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { registerPushToken } from "./notifications/push";

/**
 * Asks for notifications once the account has a bot to be notified about, not on the first open
 * of an empty inbox. A device that already allowed notifications registers as soon as the
 * session is there, since an offline or uncached open must not leave its token stale. An anchored
 * rule in app/index.tsx calls it in place of upstream's effect.
 */
export function usePushWhenAccountHasBot(enabled: boolean, hasBot: boolean) {
  const registered = useRef(false);
  useEffect(() => {
    if (!enabled) {
      registered.current = false;
      return;
    }
    if (registered.current) return;
    if (hasBot) {
      registered.current = true;
      void bestEffort("register the push token", registerPushToken());
      return;
    }
    let cancelled = false;
    void bestEffort(
      "register the push token of a device that allowed notifications",
      Notifications.getPermissionsAsync().then((permission) => {
        if (!permission.granted || cancelled || registered.current) return;
        registered.current = true;
        return registerPushToken();
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, hasBot]);
}
