// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  reachable: true,
  listeners: new Set<() => void>(),
  offline: new Set<string>(),
  relayListeners: new Set<() => void>(),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.flatMap((part, index) => [part, values[index] ?? ""]).join(""),
  }),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div role="status">{children}</div>,
}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://computer.test",
  isServerReachable: () => store.reachable,
  subscribeServerReachable: (listener: () => void) => {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  },
}));
vi.mock("./dozo-relay-fetch", () => ({
  isRelayComputerOffline: (origin: string) => store.offline.has(origin),
  subscribeRelayState: (listener: () => void) => {
    store.relayListeners.add(listener);
    return () => store.relayListeners.delete(listener);
  },
}));
vi.mock("./native", () => ({
  useMobileTokens: () => ({ mutedForeground: "muted", border: "border" }),
}));

import { CONNECTION_LINE_DELAY_MS, DozoConnectionLine } from "../components/dozo-connection-line";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const line = () => container.querySelector('[role="status"]');

function reachable(value: boolean) {
  act(() => {
    store.reachable = value;
    for (const listener of [...store.listeners]) listener();
  });
}
function computerOffline(value: boolean) {
  act(() => {
    if (value) store.offline.add("https://computer.test");
    else store.offline.delete("https://computer.test");
    for (const listener of [...store.relayListeners]) listener();
  });
}
function render(hidden = false) {
  act(() => root.render(<DozoConnectionLine hidden={hidden} />));
}
function wait(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  store.reachable = true;
  store.listeners.clear();
  store.offline.clear();
  store.relayListeners.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("DozoConnectionLine", () => {
  it("shows nothing while the server answers", () => {
    render();
    wait(CONNECTION_LINE_DELAY_MS * 2);
    expect(line()).toBeNull();
  });

  it("says it is reconnecting once the server has been gone for a while, and goes when it is back", () => {
    render();
    reachable(false);
    wait(CONNECTION_LINE_DELAY_MS - 1);
    expect(line()).toBeNull();
    wait(1);
    expect(line()?.textContent).toBe("Can't reach the server. Reconnecting…");
    reachable(true);
    expect(line()).toBeNull();
  });

  it("waits again from the start after a short outage", () => {
    render();
    reachable(false);
    wait(CONNECTION_LINE_DELAY_MS - 1);
    reachable(true);
    reachable(false);
    wait(CONNECTION_LINE_DELAY_MS - 1);
    expect(line()).toBeNull();
    wait(1);
    expect(line()).not.toBeNull();
  });

  it("says at once that the paired computer is offline, and goes when it answers again", () => {
    render();
    computerOffline(true);
    // The relay says so before any request failed: nothing is shown while requests still answer.
    expect(line()).toBeNull();
    reachable(false);
    expect(line()?.textContent).toBe("Your computer is offline. Reconnecting…");
    computerOffline(false);
    expect(line()).toBeNull();
    wait(CONNECTION_LINE_DELAY_MS);
    expect(line()?.textContent).toBe("Can't reach the server. Reconnecting…");
    reachable(true);
    expect(line()).toBeNull();
  });

  it("stays out of the way of the chats' own load failure", () => {
    render(true);
    reachable(false);
    wait(CONNECTION_LINE_DELAY_MS);
    expect(line()).toBeNull();
  });
});
