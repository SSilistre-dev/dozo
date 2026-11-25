import { Trans } from "@lingui/react/macro";
import { Button, buttonVariants, Label, Switch } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { useSave } from "../lib/query/query";
import { listUserDevices } from "../lib/auth/user-devices";
import { SettingsGroup, SettingsRow } from "./settings/SettingsRows";

/**
 * The address an older Dozo desktop app opens its own Settings window for, and does nothing else
 * (`dozo/desktop/src/server.rs`, `APP_SETTINGS`). Only used while the app has no bridge.
 */
export const DESKTOP_SETTINGS = "dozo-app://settings";

/** A switch of the desktop app, by the name its bridge uses (`dozo/desktop/src/page_bridge.rs`). */
type DesktopKey = "openAtLogin" | "keepRunning" | "pushToTalk" | "thisComputer" | "passwordManager";

/** What the desktop app says it has now; switches it does not offer right now are left out. */
export type DesktopSettings = {
  version: string;
  /** The keys of Push to Talk, as the app's own menu names them. */
  talkKeys: string;
  switches: { key: string; on: boolean }[];
};

/**
 * The desktop app's bridge. `settings` answers once what it has differs from `seen` (`null` when it
 * refuses); `set` and `open` answer nothing, whatever they did. Turning on "Let bots use this
 * computer" or the password manager only asks the person, in a window of the app's own.
 */
export type DesktopBridge = {
  settings(seen?: DesktopSettings | null): Promise<DesktopSettings | null>;
  set(key: DesktopKey, on: boolean): Promise<unknown>;
  open(what: "changeServer" | "appSettings"): Promise<unknown>;
};

declare global {
  interface Window {
    /** Set by the Dozo desktop app's window before the page loads; a browser never has it. */
    dozoDesktopShell?: boolean;
    /** Set alongside it by a desktop app that has the bridge; older ones do not. */
    dozoDesktop?: DesktopBridge;
  }
}

export function inDesktopShell(): boolean {
  return typeof window !== "undefined" && window.dozoDesktopShell === true;
}

function desktopBridge(): DesktopBridge | null {
  return inDesktopShell() ? (window.dozoDesktop ?? null) : null;
}

/**
 * Whether Computers offers to connect this computer: in an older desktop app only. With the bridge,
 * "Let bots use this computer" in the Desktop app section is that one control.
 */
export function offersConnectThisComputer(): boolean {
  return inDesktopShell() && !desktopBridge();
}

const LABELS: Record<DesktopKey, ReactNode> = {
  openAtLogin: <Trans>Open at login</Trans>,
  keepRunning: <Trans>Keep running in background</Trans>,
  pushToTalk: <Trans>Push to talk</Trans>,
  thisComputer: <Trans>Let bots use this computer</Trans>,
  passwordManager: <Trans>Password manager</Trans>,
};

function isKey(key: string): key is DesktopKey {
  return Object.hasOwn(LABELS, key);
}

/**
 * Settings > General in the desktop app: the app's own settings, read from it and kept current as
 * they change. An app without the bridge, or one that refuses, gets the row that opens its Settings
 * window instead. Elsewhere, nothing.
 */
export function DozoDesktopAppRow() {
  if (!inDesktopShell()) return null;
  const bridge = desktopBridge();
  return bridge ? <DesktopAppSection bridge={bridge} /> : <OpenAppSettingsRow />;
}

function OpenAppSettingsRow() {
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

/** What the app has, followed while shown: `undefined` until it answers, `null` when it refuses. */
function useDesktopSettings(bridge: DesktopBridge) {
  const [shown, setShown] = useState<DesktopSettings | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void (async () => {
      let seen: DesktopSettings | null = null;
      // Each answer comes when something changed; the app is never asked on a timer.
      while (active) {
        const next: DesktopSettings | null = await bridge.settings(seen).catch(() => null);
        if (!active) return;
        if (!next) {
          // Refused: what is shown stays, and before anything was shown the old row stands in.
          if (seen === null) setShown(null);
          return;
        }
        seen = next;
        setShown(next);
      }
    })();
    return () => {
      active = false;
    };
  }, [bridge]);
  return shown;
}

function DesktopAppSection({ bridge }: { bridge: DesktopBridge }) {
  const shown = useDesktopSettings(bridge);
  const save = useSave({
    save: ({ key, on }: { key: DesktopKey; on: boolean }) => bridge.set(key, on),
  });
  if (shown === null) return <OpenAppSettingsRow />;
  if (!shown) return null;
  const switches = shown.switches.filter((entry): entry is { key: DesktopKey; on: boolean } =>
    isKey(entry.key),
  );
  return (
    <SettingsGroup title={<Trans>Desktop app</Trans>} data-testid="dozo-desktop-app">
      {switches.map(({ key, on }) => (
        <DesktopSwitchRow
          key={key}
          label={LABELS[key]}
          detail={key === "pushToTalk" ? shown.talkKeys : null}
          testId={`dozo-desktop-${key}`}
          checked={save.pending && save.input?.key === key ? save.input.on : on}
          disabled={save.pending}
          onChange={(checked) => save.run({ key, on: checked })}
          action={
            key === "passwordManager" && on ? (
              <Button variant="ghost" size="sm" onClick={() => void bridge.open("appSettings")}>
                <Trans>Logins</Trans>
              </Button>
            ) : null
          }
        />
      ))}
      <SettingsRow
        label={<span className="text-muted-foreground">{window.location.host}</span>}
        control={
          <Button variant="ghost" size="sm" onClick={() => void bridge.open("changeServer")}>
            <Trans>Change server</Trans>
          </Button>
        }
      />
      <SettingsRow
        label={<Trans>Version</Trans>}
        control={<span className="text-muted-foreground">{shown.version}</span>}
      />
    </SettingsGroup>
  );
}

function DesktopSwitchRow({
  label,
  detail,
  testId,
  checked,
  disabled,
  onChange,
  action,
}: {
  label: ReactNode;
  detail: string | null;
  testId: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  action: ReactNode;
}) {
  const id = useId();
  return (
    <SettingsRow
      label={
        <Label htmlFor={id} className="text-body font-normal text-foreground">
          {label}
          {detail ? <kbd className="ml-2 font-sans text-muted-foreground">{detail}</kbd> : null}
        </Label>
      }
      control={
        <>
          {action}
          <Switch
            id={id}
            data-testid={testId}
            checked={checked}
            disabled={disabled}
            onCheckedChange={onChange}
          />
        </>
      }
    />
  );
}

/**
 * The Computers group of Settings > General in an older desktop app (`ComputerDeviceSettings`,
 * which such an app shows even before a computer is paired) while no computer of the account is
 * connected: opens the app's own Settings, where "Let Bots Use This Computer" is. The page can
 * only open that window; turning it on stays the app's question to the person.
 */
export function DozoConnectThisComputer() {
  const shell = offersConnectThisComputer();
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
