// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ reachable: true, listeners: new Set<() => void>() }));

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
  isServerReachable: () => store.reachable,
  subscribeServerReachable: (listener: () => void) => {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
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

  it("stays out of the way of the chats' own load failure", () => {
    render(true);
    reachable(false);
    wait(CONNECTION_LINE_DELAY_MS);
    expect(line()).toBeNull();
  });
});
