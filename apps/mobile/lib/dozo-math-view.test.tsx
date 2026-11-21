// @vitest-environment jsdom
import { darkTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const web = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
  mounts: 0,
}));

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, style, ...props }: Record<string, unknown> & { children?: ReactNode }) =>
    createElement(
      "div",
      {
        "aria-label": props.accessibilityLabel as string,
        role: props.accessibilityRole as string,
        "data-accessible": String(props.accessible),
        "data-style": JSON.stringify(Object.assign({}, ...([style].flat() as object[]))),
      },
      children,
    ),
}));
vi.mock("react-native-webview", () => ({
  WebView: (props: Record<string, unknown>) => {
    web.props = props;
    web.mounts++;
    return createElement("webview");
  },
}));
// The options the web draws with (`packages/chat-ui/src/dozo-math-options.ts`, which has its own test).
vi.mock("@rakazo/chat-ui/native", () => ({
  mathOptions: (displayMode: boolean) => ({
    displayMode,
    throwOnError: true,
    trust: false,
    strict: "ignore",
    maxSize: 20,
    maxExpand: 100,
    macros: {},
    output: "htmlAndMathml",
  }),
}));

import { MathView } from "../components/dozo-math-view";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const roots: { container: HTMLElement; unmount: () => void }[] = [];

async function show(tex: string, display: boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ container, unmount: () => root.unmount() });
  await act(async () => {
    root.render(
      <MathView
        tex={tex}
        display={display}
        palette={darkTokens}
        colorScheme="dark"
        fallback={<code>{`code:${tex}`}</code>}
      />,
    );
  });
  // KaTeX loads on the next tick.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

const handler = (name: string) =>
  (web.props as Record<string, unknown>)[name] as (...args: unknown[]) => unknown;

const message = (data: object) =>
  act(() => void handler("onMessage")({ nativeEvent: { data: JSON.stringify(data) } }));

beforeEach(() => {
  web.props = undefined;
  web.mounts = 0;
});
afterEach(() => {
  vi.useRealTimers();
  for (const { container, unmount } of roots.splice(0)) {
    act(unmount);
    container.remove();
  }
});

it("keeps the code on screen while the formula is measured, then shows only the formula", async () => {
  const page = await show("x^2", false);
  expect(page.textContent).toBe("code:x^2");
  const source = web.props?.source as { html: string; baseUrl: string };
  expect(source.baseUrl).toBe("about:blank");
  expect(source.html).toContain("<math");
  expect(source.html).not.toMatch(/<script|src=|href=|url\(/);
  expect(web.props?.injectedJavaScript).toContain("MathMLElement");
  await message({ type: "drawn", width: 500, height: 24 });
  expect(page.textContent).toBe("");
  const frame = page.querySelector("div");
  expect(frame?.getAttribute("aria-label")).toBe("x^2");
  expect(frame?.getAttribute("role")).toBe("image");
  expect(frame?.getAttribute("data-accessible")).toBe("true");
  // A formula in a line is capped at the line's reach and scrolls inside it.
  expect(JSON.parse(frame?.getAttribute("data-style") ?? "{}")).toEqual({ width: 320, height: 24 });
});

it("draws a display formula across the width", async () => {
  const page = await show("\\int x", true);
  await message({ type: "drawn", width: 80, height: 40 });
  expect(JSON.parse(page.querySelector("div")?.getAttribute("data-style") ?? "{}")).toEqual({
    width: "100%",
    height: 40,
  });
});

it("measures at the width the formula will be shown at, unseen", async () => {
  const inline = await show("a", false);
  expect(JSON.parse(inline.querySelector("div")?.getAttribute("data-style") ?? "{}")).toEqual({
    opacity: 0,
    width: 1,
    height: 1,
  });
  expect(inline.querySelector("div")?.getAttribute("data-accessible")).toBe("false");
  const block = await show("a", true);
  expect(JSON.parse(block.querySelector("div")?.getAttribute("data-style") ?? "{}")).toMatchObject({
    width: "100%",
  });
});

it("blocks every page but its own and every kind of file access", async () => {
  await show("a", false);
  const allow = web.props?.onShouldStartLoadWithRequest as (request: { url: string }) => boolean;
  expect(allow({ url: "about:blank" })).toBe(true);
  expect(allow({ url: "about:blank/" })).toBe(true);
  expect(allow({ url: "https://example.test/" })).toBe(false);
  expect(allow({ url: "file:///etc/passwd" })).toBe(false);
  expect(web.props).toMatchObject({
    allowFileAccess: false,
    allowUniversalAccessFromFileURLs: false,
    domStorageEnabled: false,
    javaScriptCanOpenWindowsAutomatically: false,
    setSupportMultipleWindows: false,
  });
});

it("keeps the code for broken TeX, without a page", async () => {
  const page = await show("\\frac{1}{", false);
  expect(page.textContent).toBe("code:\\frac{1}{");
  expect(web.mounts).toBe(0);
});

it("keeps the code when the page says it cannot draw, or sends a size no formula has", async () => {
  const failed = await show("x", false);
  await message({ type: "failed" });
  expect(failed.textContent).toBe("code:x");
  await show("y", false);
  await message({ type: "drawn", width: 10, height: 99999 });
  expect(roots[1]?.container.textContent).toBe("code:y");
});

it("ignores a message the page does not send, and a load error keeps the code", async () => {
  const page = await show("x", false);
  await message({ type: "other" });
  expect(page.textContent).toBe("code:x");
  act(() => void handler("onError")());
  expect(page.textContent).toBe("code:x");
  expect(web.mounts).toBeGreaterThan(0);
});

it("gives up after the timeout, but not once drawn", async () => {
  vi.useFakeTimers();
  const slow = await showWithTimers("a");
  await act(async () => void vi.advanceTimersByTime(5_000));
  expect(slow.textContent).toBe("code:a");
  const fast = await showWithTimers("b");
  await message({ type: "drawn", width: 20, height: 20 });
  await act(async () => void vi.advanceTimersByTime(5_000));
  expect(fast.textContent).toBe("");
});

async function showWithTimers(tex: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ container, unmount: () => root.unmount() });
  await act(async () => {
    root.render(
      <MathView
        tex={tex}
        display={false}
        palette={darkTokens}
        colorScheme="dark"
        fallback={<code>{`code:${tex}`}</code>}
      />,
    );
    await vi.dynamicImportSettled();
  });
  return container;
}

it("stops waiting for KaTeX when the message goes away", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <MathView tex="q" display={false} palette={darkTokens} colorScheme="dark" fallback={null} />,
    ),
  );
  act(() => root.unmount());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(web.mounts).toBe(0);
});
