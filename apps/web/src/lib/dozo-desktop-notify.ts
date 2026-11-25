import { useState } from "react";
import { requestBrowserNotificationPermission } from "./platform/browser-notifications";
import { useEventListener } from "./use-event-listener";

/**
 * In the desktop app's window, ask for notifications on the first click or key press. The app
 * answers for its own server's origin only, and the system web view on Linux forgets the answer
 * when the app restarts and wants a click behind each request, so without this nothing notified
 * after a restart until a message was sent. Where the app or the system refuses (macOS), the
 * request ends at "denied" and is not asked again. Elsewhere, and in a browser, nothing happens:
 * the browser asks as it always did.
 */
export function useDesktopNotificationAsk() {
  const [armed, setArmed] = useState(
    () =>
      window.dozoDesktopShell === true &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default",
  );
  const ask = () => {
    setArmed(false);
    void requestBrowserNotificationPermission();
  };
  const target = armed ? window : null;
  useEventListener(target, "pointerdown", ask, true);
  useEventListener(target, "keydown", ask, true);
}
