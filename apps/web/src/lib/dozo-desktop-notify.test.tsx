// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDesktopNotificationAsk } from "./dozo-desktop-notify";

let root: Root;
const request = vi.fn(async () => "granted");
function Harness() {
  useDesktopNotificationAsk();
  return null;
}
function mount(permission: string, shell: boolean) {
  vi.stubGlobal("Notification", { permission, requestPermission: request });
  if (shell) vi.stubGlobal("dozoDesktopShell", true);
  act(() => root.render(<Harness />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockClear();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("asks once, on the first click, in the desktop app's window", () => {
  mount("default", true);
  expect(request).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("pointerdown"));
  window.dispatchEvent(new KeyboardEvent("keydown"));
  expect(request).toHaveBeenCalledTimes(1);
});

it("asks on a key press too", () => {
  mount("default", true);
  window.dispatchEvent(new KeyboardEvent("keydown"));
  expect(request).toHaveBeenCalledTimes(1);
});

it("never asks in a browser, or when the answer is already known", () => {
  mount("default", false);
  window.dispatchEvent(new Event("pointerdown"));
  act(() => root.unmount());
  root = createRoot(document.createElement("div"));
  for (const known of ["granted", "denied"]) {
    mount(known, true);
    window.dispatchEvent(new Event("pointerdown"));
    act(() => root.unmount());
    root = createRoot(document.createElement("div"));
  }
  expect(request).not.toHaveBeenCalled();
});

it("stops listening when the shell goes", () => {
  mount("default", true);
  act(() => root.render(null));
  window.dispatchEvent(new Event("pointerdown"));
  expect(request).not.toHaveBeenCalled();
});
