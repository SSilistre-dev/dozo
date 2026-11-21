import { Trans } from "@lingui/react/macro";
import { buttonVariants } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { listUserDevices } from "../lib/user-devices";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/**
 * The one address of the Dozo desktop app a page may go to: its window opens the app's own
 * Settings window and does nothing else (`dozo/desktop/src/server.rs`, `APP_SETTINGS`).
 */
export const DESKTOP_SETTINGS = "dozo-app://settings";

declare global {
  interface Window {
    /** Set by the Dozo desktop app's window before the page loads; a browser never has it. */
    dozoDesktopShell?: boolean;
  }
}

export function inDesktopShell(): boolean {
  return typeof window !== "undefined" && window.dozoDesktopShell === true;
}

/** Settings > General in the desktop app: opens the app's own Settings. Elsewhere, nothing. */
export function DozoDesktopAppRow() {
  if (!inDesktopShell()) return null;
  return (
    <SettingsGroup data-testid="dozo-desktop-app">
      <SettingsRow
        label={<Trans>Desktop app</Trans>}
        control={
          <a href={DESKTOP_SETTINGS} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <Trans>Open</Trans>
          </a>
        }
      />
    </SettingsGroup>
  );
}

/**
 * The Computers group of Settings > General in the desktop app (`ComputerDeviceSettings`, which
 * the app shows even before a computer is paired) while no computer of the account is connected: opens
 * the app's own Settings, where "Let Bots Use This Computer" is. The page can only open that
 * window; turning it on stays the app's question to the person.
 */
export function DozoConnectThisComputer() {
  const shell = inDesktopShell();
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    if (!shell) return;
    let active = true;
    listUserDevices().then(
      (devices) => {
        if (active) setConnected(devices.some((device) => device.connected));
      },
      () => {
        if (active) setConnected(null);
      },
    );
    return () => {
      active = false;
    };
  }, [shell]);
  if (connected !== false) return null;
  return (
    <div className="px-4 py-3">
      <a
        href={DESKTOP_SETTINGS}
        data-testid="dozo-connect-this-computer"
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        <Trans>Connect this computer</Trans>
      </a>
    </div>
  );
}
