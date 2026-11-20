// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MATH_SOURCE, mathOptions } from "./dozo-markdown-math.web";
import { ChatMarkdown } from "./markdown.web";

let container: HTMLDivElement;
let root: Root;

async function render(markdown: string, streaming = false) {
  await act(async () => {
    root.render(<ChatMarkdown streaming={streaming}>{markdown}</ChatMarkdown>);
  });
}

/** Waits until KaTeX has drawn `count` formulas. */
async function drawn(count = 1) {
  await vi.waitFor(() => expect(container.querySelectorAll(".katex")).toHaveLength(count));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("chat math", () => {
  it("draws inline and display formulas, keeping the TeX for copy and screen readers", async () => {
    await render("Area $\\pi r^2$ and\n\n$$\n\\sum_{i=1}^n i\n$$");
    await drawn(2);
    const inline = container.querySelector("p .rk-math");
    expect(inline?.querySelector("annotation")?.textContent).toBe("\\pi r^2");
    const display = container.querySelector(".rk-math-display");
    expect(display?.querySelector(".katex-display")).not.toBeNull();
    expect(display?.querySelector("math")).not.toBeNull();
  });

  it("leaves prices alone", async () => {
    await render("It costs $5 and $10 per month.");
    expect(container.textContent).toBe("It costs $5 and $10 per month.");
    expect(container.querySelector(".rk-math")).toBeNull();
  });

  it("draws math inside a table cell", async () => {
    await render("| n | square |\n| --- | --- |\n| 2 | $2^2$ |");
    await drawn();
    expect(container.querySelector("td .katex")).not.toBeNull();
  });

  it("shows a formula still streaming in as its source, then draws it", async () => {
    await render("Then\n\n$$\n\\frac{a}{", true);
    expect(container.querySelector(".rk-math")).toBeNull();
    expect(container.textContent).toContain("$$\n\\frac{a}{");
    await render("Then\n\n$$\n\\frac{a}{b}\n$$", true);
    await drawn();
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("shows TeX KaTeX cannot draw as its source", async () => {
    await render("Ok $x$ and $\\frac{a}{$ end");
    await drawn();
    await vi.waitFor(() =>
      expect(container.querySelector(".rk-math-source")?.textContent).toBe("$\\frac{a}{$"),
    );
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("shows very long source as written", async () => {
    await render(`$$${"x".repeat(MAX_MATH_SOURCE + 1)}$$`);
    await render("$y$");
    await drawn();
    await render(`$$${"x".repeat(MAX_MATH_SOURCE + 1)}$$`);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".rk-math-display.rk-math-source")).not.toBeNull();
  });

  it("refuses links, HTML and runaway macros from untrusted text", async () => {
    await render(
      "$\\href{javascript:alert(1)}{x}$ $\\url{https://example.com}$ $\\htmlId{a}{b}$ $\\includegraphics{https://example.com/a.png}$",
    );
    await vi.waitFor(() => expect(container.querySelectorAll(".rk-math")).toHaveLength(4));
    expect(container.querySelector("a, img, #a")).toBeNull();
    await render("$\\def\\a{\\a}\\a$");
    await vi.waitFor(() =>
      expect(container.querySelector(".rk-math-source")?.textContent).toBe("$\\def\\a{\\a}\\a$"),
    );
  });

  it("gives every formula its own macros", async () => {
    await render("$\\gdef\\mine{7}\\mine$ and $\\mine$");
    await drawn();
    expect(container.querySelector(".rk-math-source")?.textContent).toBe("$\\mine$");
    expect(mathOptions(false)).toMatchObject({ trust: false, maxExpand: 100, throwOnError: true });
  });
});
