// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ devices: vi.fn() }));

vi.mock("../lib/user-devices", () => ({ listUserDevices: api.devices }));
vi.mock("../lib/rpc", () => ({
  rpc: {},
  rpcForSpace: () => ({}),
  createSpaceRpc: () => ({}),
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  buttonVariants: () => "button",
  Button: ({ children, onClick, ...props }: ComponentProps<"button">) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Label: ({ htmlFor, children }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    id: string;
    disabled?: boolean;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      {...props}
    />
  ),
}));
vi.mock("./SettingsRows", () => ({
  SettingsGroup: ({ title, children }: { title?: ReactNode; children: ReactNode }) => (
    <section>
      {title}
      {children}
    </section>
  ),
  SettingsRow: ({ label, control }: { label: ReactNode; control: ReactNode }) => (
    <div>
      <span>{label}</span>
      {control}
    </div>
  ),
}));

import type { DesktopBridge, DesktopSettings } from "./dozo-desktop-app";
import {
  DESKTOP_SETTINGS,
  DozoConnectThisComputer,
  DozoDesktopAppRow,
  offersConnectThisComputer,
} from "./dozo-desktop-app";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function show(node: ReactNode) {
  await act(async () =>
    root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>),
  );
}

const SETTINGS: DesktopSettings = {
  version: "0.7.0",
  talkKeys: "Ctrl+Shift+Space",
  switches: [
    { key: "openAtLogin", on: true },
    { key: "keepRunning", on: false },
    { key: "pushToTalk", on: false },
    { key: "thisComputer", on: false },
    { key: "passwordManager", on: true },
    // A switch a newer app offers that this page does not know is left out.
    { key: "somethingNew", on: true },
  ],
};

/**
 * A desktop app with the bridge: each read answers with the next of `answers`, then the next one
 * waits for `later`, and any after it wait for good, as the app answers only once something changed.
 */
function withBridge(...answers: (DesktopSettings | null)[]) {
  const reads: (DesktopSettings | null | undefined)[] = [];
  const later = deferred<DesktopSettings | null>();
  let waited = false;
  const bridge = {
    settings: vi.fn((seen?: DesktopSettings | null) => {
      reads.push(seen);
      const next = answers.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (waited) return deferred<DesktopSettings | null>().promise;
      waited = true;
      return later.promise;
    }),
    set: vi.fn(() => Promise.resolve(null)),
    open: vi.fn(() => Promise.resolve(null)),
  } satisfies DesktopBridge;
  window.dozoDesktopShell = true;
  window.dozoDesktop = bridge;
  return { bridge, reads, later };
}

const toggle = (key: string) =>
  container.querySelector<HTMLInputElement>(`[data-testid="dozo-desktop-${key}"]`);
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === text);

function links() {
  return [...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.devices.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete window.dozoDesktopShell;
  delete window.dozoDesktop;
});

describe("DozoDesktopAppRow", () => {
  it("shows nothing in a browser", async () => {
    await show(<DozoDesktopAppRow />);
    expect(container.innerHTML).toBe("");
  });

  it("opens the app's Settings in the desktop app", async () => {
    window.dozoDesktopShell = true;
    await show(<DozoDesktopAppRow />);
    expect(container.textContent).toContain("Desktop app");
    expect(links()).toEqual([["Open", "dozo-app://settings"]]);
    expect(DESKTOP_SETTINGS).toBe("dozo-app://settings");
  });
});

describe("DozoDesktopAppRow with the app's bridge", () => {
  it("asks the app nothing in a browser, even where a page set the bridge itself", async () => {
    const { bridge } = withBridge(SETTINGS);
    delete window.dozoDesktopShell;
    await show(<DozoDesktopAppRow />);
    expect(container.innerHTML).toBe("");
    expect(bridge.settings).not.toHaveBeenCalled();
  });

  it("shows the app's switches and version in place of the row", async () => {
    withBridge(SETTINGS);
    await show(<DozoDesktopAppRow />);
    expect(container.textContent).toContain("Desktop app");
    expect(links()).toEqual([]);
    for (const [key, on] of [
      ["openAtLogin", true],
      ["keepRunning", false],
      ["pushToTalk", false],
      ["thisComputer", false],
      ["passwordManager", true],
    ] as const) {
      expect(toggle(key)?.checked, key).toBe(on);
    }
    expect(toggle("somethingNew")).toBeNull();
    for (const words of [
      "Open at login",
      "Keep running in background",
      "Push to talk",
      "Ctrl+Shift+Space",
      "Let bots use this computer",
      "Password manager",
      "Change server",
      "Version",
      "0.7.0",
    ]) {
      expect(container.textContent).toContain(words);
    }
  });

  it("shows nothing until the app answers", async () => {
    withBridge();
    await show(<DozoDesktopAppRow />);
    expect(container.innerHTML).toBe("");
  });

  it("follows the app, telling it what is shown", async () => {
    const { reads, later } = withBridge(SETTINGS);
    await show(<DozoDesktopAppRow />);
    expect(reads).toEqual([null, SETTINGS]);
    const changed = {
      ...SETTINGS,
      switches: [{ key: "keepRunning", on: true }],
    };
    await act(async () => later.resolve(changed));
    expect(toggle("keepRunning")?.checked).toBe(true);
    expect(toggle("openAtLogin")).toBeNull();
  });

  it("sends what the person sets and shows it while the app takes it", async () => {
    const { bridge } = withBridge(SETTINGS);
    const taken = deferred<unknown>();
    bridge.set.mockReturnValueOnce(taken.promise as Promise<null>);
    await show(<DozoDesktopAppRow />);
    await act(async () => toggle("keepRunning")?.click());
    expect(bridge.set).toHaveBeenCalledWith("keepRunning", true);
    expect(toggle("keepRunning")?.checked).toBe(true);
    // One change at a time.
    expect(toggle("pushToTalk")?.disabled).toBe(true);
    await act(async () => taken.resolve(null));
    // The app has not said it changed: what it said last is shown.
    expect(toggle("keepRunning")?.checked).toBe(false);
    await act(async () => toggle("thisComputer")?.click());
    expect(bridge.set).toHaveBeenLastCalledWith("thisComputer", true);
  });

  it("opens what only the app shows", async () => {
    const { bridge } = withBridge(SETTINGS);
    await show(<DozoDesktopAppRow />);
    await act(async () => button("Change server")?.click());
    expect(bridge.open).toHaveBeenCalledWith("changeServer");
    await act(async () => button("Logins")?.click());
    expect(bridge.open).toHaveBeenLastCalledWith("appSettings");
  });

  it("falls back to the row that opens the app's Settings when the app refuses", async () => {
    withBridge(null);
    await show(<DozoDesktopAppRow />);
    expect(links()).toEqual([["Open", "dozo-app://settings"]]);
  });

  it("keeps what it shows when a later read is refused", async () => {
    const { later } = withBridge(SETTINGS);
    await show(<DozoDesktopAppRow />);
    await act(async () => later.resolve(null));
    expect(toggle("openAtLogin")?.checked).toBe(true);
    expect(links()).toEqual([]);
  });
});

describe("DozoConnectThisComputer", () => {
  it("shows nothing in a browser and does not ask for the computers", async () => {
    await show(<DozoConnectThisComputer />);
    expect(container.innerHTML).toBe("");
    expect(api.devices).not.toHaveBeenCalled();
  });

  it("offers to connect while no computer is connected, once the list is in", async () => {
    window.dozoDesktopShell = true;
    const listed = deferred<{ deviceId: string; name: string; connected: boolean }[]>();
    api.devices.mockReturnValue(listed.promise);
    await show(<DozoConnectThisComputer />);
    expect(container.innerHTML).toBe("");
    await act(async () => listed.resolve([{ deviceId: "d1", name: "Laptop", connected: false }]));
    expect(links()).toEqual([["Connect this computer", "dozo-app://settings"]]);
  });

  it("ignores a list that arrives after it is gone", async () => {
    window.dozoDesktopShell = true;
    const first = deferred<{ deviceId: string; name: string; connected: boolean }[]>();
    const second = deferred<{ deviceId: string; name: string; connected: boolean }[]>();
    api.devices.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await show(<DozoConnectThisComputer />);
    act(() => root.unmount());
    await act(async () => first.resolve([]));
    root = createRoot(container);
    await show(<DozoConnectThisComputer />);
    act(() => root.unmount());
    await act(async () => second.reject(new Error("offline")));
    expect(container.innerHTML).toBe("");
    root = createRoot(container);
  });

  it("leaves it to the section's switch in an app with the bridge", async () => {
    withBridge(SETTINGS);
    api.devices.mockResolvedValue([]);
    await show(<DozoConnectThisComputer />);
    expect(container.innerHTML).toBe("");
    expect(api.devices).not.toHaveBeenCalled();
    expect(offersConnectThisComputer()).toBe(false);
    delete window.dozoDesktop;
    expect(offersConnectThisComputer()).toBe(true);
    delete window.dozoDesktopShell;
    expect(offersConnectThisComputer()).toBe(false);
  });

  it("stays away while a computer is connected or the list fails", async () => {
    window.dozoDesktopShell = true;
    api.devices.mockResolvedValue([{ deviceId: "d1", name: "Laptop", connected: true }]);
    await show(<DozoConnectThisComputer />);
    expect(container.innerHTML).toBe("");
    act(() => root.unmount());
    root = createRoot(container);
    api.devices.mockRejectedValue(new Error("offline"));
    await show(<DozoConnectThisComputer />);
    expect(container.innerHTML).toBe("");
  });
});
