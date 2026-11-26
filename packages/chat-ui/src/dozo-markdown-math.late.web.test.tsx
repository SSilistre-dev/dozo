// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The math parser is a chunk of its own: each test starts from modules that have not loaded it.
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.doUnmock("./dozo-markdown-math");
  vi.unstubAllGlobals();
});

async function render(markdown: string) {
  const { ChatMarkdown } = await import("./markdown.web");
  await act(async () => {
    root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
  });
}

describe("math before its parser has loaded", () => {
  it("shows the message as text, then draws the formula once the parser is there", async () => {
    await render("Area $\\pi r^2$");
    expect(container.querySelector(".rk-math")).toBeNull();
    expect(container.textContent).toBe("Area $\\pi r^2$");
    await vi.waitFor(() => expect(container.querySelector(".rk-math .katex")).not.toBeNull());
    expect(container.querySelector("p")?.textContent).toContain("Area ");
  });

  it("leaves a message without a dollar alone, loading nothing", async () => {
    const parser = vi.fn(() => ({ mathSource: (source: string) => source, remarkChatMath: [] }));
    vi.doMock("./dozo-markdown-math", parser);
    await render("No money here");
    expect(container.textContent).toBe("No money here");
    expect(parser).not.toHaveBeenCalled();
  });

  it("keeps dollars as text when the parser cannot load, and tries again with the next message", async () => {
    const tries = vi.fn();
    vi.doMock("./dozo-markdown-math", () => {
      tries();
      throw new Error("chunk failed to load");
    });
    await render("Costs $5 or $x$");
    await vi.waitFor(() => expect(tries).toHaveBeenCalledTimes(1));
    expect(container.textContent).toBe("Costs $5 or $x$");
    await render("Then $y$");
    await vi.waitFor(() => expect(tries).toHaveBeenCalledTimes(2));
    expect(container.querySelector(".rk-math")).toBeNull();
  });

  it("loads the parser once for every message, and gives later readers its plugins at once", async () => {
    const plugin = () => undefined;
    const parser = vi.fn(() => ({
      mathSource: (source: string) => `read ${source}`,
      remarkChatMath: [plugin],
    }));
    vi.doMock("./dozo-markdown-math", parser);
    const { mathSource, withChatMath, useMathReady } = await import("./dozo-markdown-math.web");
    const early = withChatMath([]);
    expect(mathSource("$a$")).toBe("$a$");
    expect(mathSource("$b$")).toBe("$b$");
    await vi.waitFor(() => expect(early).toEqual([plugin]));
    expect(parser).toHaveBeenCalledTimes(1);
    expect(withChatMath([])).toEqual([plugin]);
    expect(mathSource("$c$")).toBe("read $c$");
    let ready: boolean | undefined;
    function Probe() {
      ready = useMathReady();
      return null;
    }
    await act(async () => {
      root.render(<Probe />);
    });
    expect(ready).toBe(true);
  });

  it("renders on the server as not ready, so the page draws the text first", async () => {
    const { useMathReady } = await import("./dozo-markdown-math.web");
    function Probe() {
      return <span>{useMathReady() ? "ready" : "text"}</span>;
    }
    expect(renderToString(<Probe />)).toBe("<span>text</span>");
  });
});
