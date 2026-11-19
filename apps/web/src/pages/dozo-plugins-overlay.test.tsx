// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const chunk = vi.hoisted(() => ({ preload: vi.fn(), warm: vi.fn() }));
vi.mock("./dozo-plugins-overlay-chunk", () => ({
  preloadPluginsOverlay: chunk.preload,
  warmPluginsOverlay: chunk.warm,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", async () => {
  const { createElement } = await import("react");
  const container = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    AlertDialog: container,
    AlertDialogCancel: container,
    AlertDialogContent: container,
    AlertDialogFooter: container,
    AlertDialogHeader: container,
    AlertDialogTitle: container,
    Button: container,
    DialogClose: container,
    DialogContent: container,
    DialogHeader: container,
    DialogTitle: container,
    Dialog: ({
      children,
      onOpenChange,
    }: {
      children?: ReactNode;
      onOpenChange: (open: boolean) => void;
    }) =>
      createElement(
        "div",
        { role: "dialog" },
        createElement("button", { type: "button", onClick: () => onOpenChange(false) }, "dismiss"),
        createElement("button", { type: "button", onClick: () => onOpenChange(true) }, "keep"),
        children,
      ),
    Input: (props: { placeholder?: string; disabled?: boolean }) =>
      createElement("input", { placeholder: props.placeholder, disabled: props.disabled }),
  };
});

import { PluginsOverlay, PRELOAD_AFTER_MS, usePreloadPluginsOverlay } from "./dozo-plugins-overlay";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  chunk.preload.mockReset();
  chunk.warm.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function button(name: string) {
  const found = [...host.querySelectorAll("button")].find((node) => node.textContent === name);
  if (!found) throw new Error(`no ${name} button`);
  return found;
}

it("draws a placeholder dialog on the click, then upstream's overlay with the same props", async () => {
  const overlay = deferred<(props: { activeBotId?: string }) => ReactNode>();
  chunk.preload.mockReturnValue(overlay.promise);
  const onClose = vi.fn();
  act(() => root.render(<PluginsOverlay activeBotId="bot-1" onClose={onClose} />));
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Integrations");
  expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
    "Loading integrations…",
  );
  expect(host.querySelector("input")?.disabled).toBe(true);
  act(() => button("keep").click());
  expect(onClose).not.toHaveBeenCalled();
  act(() => button("dismiss").click());
  expect(onClose).toHaveBeenCalledTimes(1);

  await act(async () => overlay.resolve((props) => <p>upstream for {props.activeBotId}</p>));
  await vi.waitFor(() => expect(host.textContent).toContain("upstream for bot-1"));
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("fetches the overlay's code once the shell has settled", () => {
  vi.useFakeTimers();
  function Shell() {
    usePreloadPluginsOverlay();
    return null;
  }
  act(() => root.render(<Shell />));
  act(() => vi.advanceTimersByTime(PRELOAD_AFTER_MS - 1));
  expect(chunk.warm).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(chunk.warm).toHaveBeenCalledTimes(1);
});
