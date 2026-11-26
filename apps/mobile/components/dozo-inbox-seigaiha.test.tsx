// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement("em", { "data-role": accessibilityRole }, children),
  View: ({
    children,
    style,
    accessibilityElementsHidden,
    pointerEvents,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityElementsHidden?: boolean;
    pointerEvents?: string;
  }) =>
    createElement(
      "span",
      {
        "data-style": JSON.stringify(style),
        "data-hidden": accessibilityElementsHidden,
        "data-pointer": pointerEvents,
      },
      children,
    ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47 }) }));
vi.mock("react-native-svg", () => {
  const part = (name: string) => (props: { children?: ReactNode }) =>
    createElement(name, null, props.children);
  return {
    default: ({ height, children }: { height: number; children?: ReactNode }) =>
      createElement("svg", { height }, children),
    Circle: part("circle"),
    Defs: part("defs"),
    G: part("g"),
    LinearGradient: part("lineargradient"),
    Pattern: part("pattern"),
    Rect: part("rect"),
    Stop: part("stop"),
  };
});
const appearance = vi.hoisted(() => ({ current: "light" as "light" | "dark" }));
vi.mock("../lib/native/native", () => ({
  useResolvedAppearance: () => appearance.current,
  useMobileTokens: () => ({
    foreground: "#111111",
    background: "#ffffff",
    destructiveFill: "#cc0000",
  }),
}));

import { DOZO_SEIGAIHA } from "@rakazo/core";
import { DozoInboxSeigaiha, DozoWordmark, dozoWordmarkItems } from "./dozo-inbox-seigaiha";

let root: Root;
let container: HTMLDivElement;
const render = (element: ReactNode) => act(async () => root.render(element));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("covers the status bar and the fade, hidden from touches and screen readers", async () => {
  await render(createElement(DozoInboxSeigaiha));
  const height = 47 + DOZO_SEIGAIHA.fadeHeight;
  const outer = container.querySelector<HTMLElement>("[data-pointer]")!;
  expect(outer.getAttribute("data-pointer")).toBe("none");
  expect(outer.getAttribute("data-hidden")).toBe("true");
  expect(outer.getAttribute("data-style")).toContain(`"height":${height}`);
  expect(container.querySelector("svg")!.getAttribute("height")).toBe(String(height));
});

it("draws every scale of every centre, and fades to the page colour", async () => {
  await render(createElement(DozoInboxSeigaiha));
  expect(container.querySelectorAll("circle").length).toBe(
    DOZO_SEIGAIHA.centers.length * DOZO_SEIGAIHA.radii.length,
  );
  expect(container.querySelectorAll("stop").length).toBe(3);
});

it("shows the wordmark as a header", async () => {
  await render(createElement(DozoWordmark));
  const name = container.querySelector("em")!;
  expect(name.textContent).toBe("dozo");
  expect(name.getAttribute("data-role")).toBe("header");
});

it.each([
  ["light", "#d93f3f"],
  ["dark", "#e5484d"],
] as const)("draws the seal in the web red in the %s theme", async (theme, red) => {
  appearance.current = theme;
  await render(createElement(DozoWordmark));
  expect(container.querySelector("span span")!.getAttribute("data-style")).toContain(
    `"backgroundColor":"${red}"`,
  );
});

it("offers the wordmark as one header item without the shared glass", async () => {
  const items = dozoWordmarkItems();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ type: "custom", hidesSharedBackground: true });
  await render(items[0]!.element);
  expect(container.textContent).toBe("dozo");
});
