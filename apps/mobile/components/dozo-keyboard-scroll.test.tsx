// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { keyboard } = vi.hoisted(() => ({ keyboard: { visible: false } }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({
    children,
    behavior,
    automaticOffset,
  }: {
    children?: ReactNode;
    behavior?: string;
    automaticOffset?: boolean;
  }) => (
    <div data-kav={behavior} data-offset={String(automaticOffset)}>
      {children}
    </div>
  ),
  useKeyboardState: (select: (state: { isVisible: boolean }) => boolean) =>
    select({ isVisible: keyboard.visible }),
}));
vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));

import { DozoKeyboardScroll, useDozoKeyboardOpen } from "./dozo-keyboard-scroll";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  keyboard.visible = false;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("lays the form out in a keyboard-avoiding view that pads below it", async () => {
  await act(async () => root.render(<DozoKeyboardScroll>form</DozoKeyboardScroll>));
  expect(container.innerHTML).toBe(
    '<div data-kav="padding" data-offset="true"><section>form</section></div>',
  );
});

it.each([true, false])("reports the keyboard as open: %s", async (visible) => {
  keyboard.visible = visible;
  const Probe = () => <>{String(useDozoKeyboardOpen())}</>;
  await act(async () => root.render(<Probe />));
  expect(container.textContent).toBe(String(visible));
});
