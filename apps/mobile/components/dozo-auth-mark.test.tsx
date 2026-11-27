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
vi.mock("../lib/native/native", () => ({ useMobileTokens: () => ({ background: "#fcfcfc" }) }));
vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityElementsHidden,
    style,
  }: {
    children?: ReactNode;
    accessibilityElementsHidden?: boolean;
    style?: object;
  }) =>
    createElement(
      "div",
      { "data-hidden": accessibilityElementsHidden, "data-style": JSON.stringify(style) },
      children,
    ),
}));

import { DozoAuthBackdrop, DozoAuthMark, DozoPasswordToggleSlot } from "./dozo-auth-mark";

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

const styleOf = (el: Element | null | undefined) => JSON.parse(el?.getAttribute("data-style") ?? "{}");

it("draws the waves in the page behind the form, not in the form's scrolled content", async () => {
  await act(async () =>
    root.render(createElement(DozoAuthBackdrop, null, createElement("main", null, "form"))),
  );
  const page = container.firstElementChild;
  expect(styleOf(page)).toEqual({ flex: 1, backgroundColor: "#fcfcfc" });
  expect([...(page?.children ?? [])].map((el) => el.tagName)).toEqual(["I", "MAIN"]);
});

it("shows only the wordmark above the title, out of the accessibility tree", async () => {
  await act(async () => root.render(createElement(DozoAuthMark)));
  expect(container.querySelector('[data-testid="waves"]')).toBeNull();
  const hidden = container.querySelector("[data-hidden]");
  expect(hidden?.getAttribute("data-hidden")).toBe("true");
  expect(hidden?.textContent).toBe("dozo");
});

it("centres the password toggle in a 44pt target", async () => {
  await act(async () => root.render(createElement(DozoPasswordToggleSlot, null, "eye")));
  expect(styleOf(container.firstElementChild)).toMatchObject({
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  });
});
