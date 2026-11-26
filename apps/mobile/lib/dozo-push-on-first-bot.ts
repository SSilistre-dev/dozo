import { bestEffort } from "@rakazo/logging/best-effort";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { useEffect, useRef } from "react";
import { registerPushToken } from "./notifications/push";

const ASKED_KEY = "dozo.push-asked";

/** Remembers a device that has answered, so its token is kept up to date whatever the inbox holds. */
async function registerAndRemember() {
  await registerPushToken();
  if ((await Notifications.getPermissionsAsync()).granted)
    await SecureStore.setItemAsync(ASKED_KEY, "1");
}

/**
 * Asks for notifications once the account has a bot to be notified about, not on the first open
 * of an empty inbox. A device that already answered registers as soon as the session is there,
 * since an offline or uncached open must not leave its token stale. An anchored rule in
 * app/index.tsx calls it in place of upstream's effect.
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
      void bestEffort("register the push token", registerAndRemember());
      return;
    }
    let cancelled = false;
    void bestEffort(
      "register the push token of a device that was asked",
      SecureStore.getItemAsync(ASKED_KEY).then((asked) => {
        if (!asked || cancelled || registered.current) return;
        registered.current = true;
        return registerPushToken();
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, hasBot]);
}
