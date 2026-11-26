// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./dozo-inbox-seigaiha", () => ({
  DozoInboxSeigaiha: () => createElement("i", { "data-testid": "waves" }),
  DozoWordmark: () => createElement("b", null, "dozo"),
}));
vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityElementsHidden,
  }: {
    children?: ReactNode;
    accessibilityElementsHidden?: boolean;
  }) => createElement("div", { "data-hidden": accessibilityElementsHidden }, children),
}));

import { DozoAuthMark } from "./dozo-auth-mark";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("shows the waves and the wordmark", async () => {
  await act(async () => root.render(createElement(DozoAuthMark)));
  expect(container.querySelector('[data-testid="waves"]')).not.toBeNull();
  expect(container.textContent).toBe("dozo");
});

it("keeps the wordmark out of the accessibility tree, as the screen title is the header", async () => {
  await act(async () => root.render(createElement(DozoAuthMark)));
  const hidden = container.querySelector("[data-hidden]");
  expect(hidden?.getAttribute("data-hidden")).toBe("true");
  expect(hidden?.textContent).toBe("dozo");
});
