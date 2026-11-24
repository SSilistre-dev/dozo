import { useEffect } from "react";
import { requestBrowserNotificationPermission } from "./browser-notifications";

/**
 * In the desktop app's window, ask for notifications on the first click or key press. The app
 * answers for its own server's origin only, and the system web view on Linux forgets the answer
 * when the app restarts and wants a click behind each request, so without this nothing notified
 * after a restart until a message was sent. Where the app or the system refuses (macOS), the
 * request ends at "denied" and is not asked again. Elsewhere, and in a browser, nothing happens:
 * the browser asks as it always did.
 */
export function useDesktopNotificationAsk() {
  useEffect(() => {
    if (window.dozoDesktopShell !== true || typeof Notification === "undefined") return;
    if (Notification.permission !== "default") return;
    const ask = () => {
      remove();
      void requestBrowserNotificationPermission();
    };
    const remove = () => {
      window.removeEventListener("pointerdown", ask, true);
      window.removeEventListener("keydown", ask, true);
    };
    window.addEventListener("pointerdown", ask, true);
    window.addEventListener("keydown", ask, true);
    return remove;
  }, []);
}
