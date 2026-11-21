// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => (await import("./dozo-native-mock.test.helper")).nativeMock());

import { MAX_FORMULAS_PER_MESSAGE } from "./dozo-math-options";
import type { MathViewProps, TableToolsProps } from "./markdown.native";
import {
  ChatMarkdown,
  MarkdownCopyProvider,
  MathViewContext,
  TableToolsContext,
} from "./markdown.native";
import type { MarkdownCopy } from "./markdown-copy";
import { defaultMarkdownCopy } from "./markdown-copy";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const containers: HTMLElement[] = [];

function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  act(() => createRoot(container).render(node));
  return container;
}

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

const drawn: MathViewProps[] = [];
function StubMath(props: MathViewProps) {
  drawn.push(props);
  return createElement("i", {
    "data-tex": props.tex,
    "data-display": String(props.display),
    "aria-label": props.tex,
  });
}

function withMath(markdown: string, streaming = false) {
  drawn.length = 0;
  return render(
    <MathViewContext.Provider value={StubMath}>
      <ChatMarkdown streaming={streaming}>{markdown}</ChatMarkdown>
    </MathViewContext.Provider>,
  );
}

describe("math on mobile", () => {
  it("shows a formula as code where the app cannot draw it", () => {
    const html = render(
      <ChatMarkdown>{"Area is $\\pi r^2$ here\n\n$$\n\\int_0^1 x\\,dx\n$$"}</ChatMarkdown>,
    ).textContent;
    expect(html).toContain("\\pi r^2");
    expect(html).toContain("\\int_0^1 x\\,dx");
    expect(html).not.toContain("$");
  });

  it("shows a block formula as code in the light scheme too", () => {
    const page = render(<ChatMarkdown colorScheme="light">{"$$\nx_1\n$$"}</ChatMarkdown>);
    expect(page.textContent).toContain("x_1");
  });

  it("hands inline and block formulas to the app's drawing, TeX as written", () => {
    const page = withMath("Area is $a_b*c$ here\n\n$$\n\\frac{1}{2}\n$$");
    expect(drawn.map(({ tex, display }) => [tex, display])).toEqual([
      ["a_b*c", false],
      ["\\frac{1}{2}\n", true],
    ]);
    expect(page.querySelectorAll("i[data-tex]")).toHaveLength(2);
    // The code the app shows until the formula is drawn is given along.
    expect(render(drawn[0]?.fallback).textContent).toBe("a_b*c");
    expect(render(drawn[1]?.fallback).textContent).toContain("frac");
  });

  it("keeps a formula as code while the reply streams, and when it is too long or empty", () => {
    expect(withMath("so $x^2$ is", true).querySelector("i")).toBeNull();
    const long = `$${"x+".repeat(2100)}1$`;
    expect(withMath(long).querySelector("i")).toBeNull();
    expect(withMath("$$\n \n$$").querySelector("i")).toBeNull();
    expect(drawn).toEqual([]);
  });

  it("draws the first formulas of a message and leaves the rest as code", () => {
    const formulas = Array.from({ length: 14 }, (_, i) => `$f_${i}$`).join(" and ");
    const page = withMath(`${formulas}\n\n$$\nblock\n$$`);
    expect(drawn).toHaveLength(MAX_FORMULAS_PER_MESSAGE);
    // The block is read first, so it and eleven inline formulas are drawn; the last three are code.
    expect(drawn.map(({ tex }) => tex)).toContain("block\n");
    expect(drawn.map(({ tex }) => tex)).not.toContain("f_11");
    expect(page.textContent).toContain("f_11 and f_12 and f_13");
    // The formulas of another message start again from the first.
    withMath("$g$");
    expect(drawn.map(({ tex }) => tex)).toEqual(["g"]);
  });

  it("leaves prices as text", () => {
    expect(withMath("It costs $5 and $10 total").querySelector("i")).toBeNull();
  });
});

const TABLE = `| Name | Score |
| --- | --- |
| Bo | 10 |
| Al | 9 |
| Cy | $x^2$ |`;

const toolCalls: TableToolsProps[] = [];
function Tools(props: TableToolsProps) {
  toolCalls.push(props);
  return createElement("b", { "data-csv": props.csv });
}

function names(page: HTMLElement) {
  return [...page.querySelectorAll("rn-view")]
    .map((view) => view.textContent)
    .filter(
      (text) => ["Bo", "Al", "Cy"].some((name) => text?.startsWith(name)) && text.length < 12,
    );
}

const headers = (page: HTMLElement) =>
  [...page.querySelectorAll<HTMLElement>("rn-pressable")].map((button) => button.ariaLabel);

const press = (page: HTMLElement, label: string) =>
  act(() => page.querySelector<HTMLElement>(`rn-pressable[aria-label="${label}"]`)?.click());

describe("tables on mobile", () => {
  it("sorts by a header: ascending, descending, then as written", () => {
    const page = render(
      <ChatMarkdown>{"| Name | Score |\n| --- | --- |\n| Bo | 10 |\n| Al | 9 |"}</ChatMarkdown>,
    );
    expect(headers(page)).toEqual(["Sort by Name", "Sort by Score"]);
    const order = () => page.textContent;
    expect(order()).toContain("Bo");
    press(page, "Sort by Name");
    expect(headers(page)).toEqual(["Sorted by Name, ascending", "Sort by Score"]);
    expect(page.textContent?.indexOf("Al")).toBeLessThan(page.textContent?.indexOf("Bo") ?? 0);
    press(page, "Sorted by Name, ascending");
    expect(headers(page)[0]).toBe("Sorted by Name, descending");
    expect(page.textContent?.indexOf("Bo")).toBeLessThan(page.textContent?.indexOf("Al") ?? 0);
    press(page, "Sorted by Name, descending");
    expect(headers(page)[0]).toBe("Sort by Name");
  });

  it("sorts numbers as numbers and marks the sorted column", () => {
    const page = render(
      <ChatMarkdown>
        {"| Name | Score |\n| --- | --- |\n| Bo | 10 |\n| Al | 9 |\n| Cy | 100 |"}
      </ChatMarkdown>,
    );
    press(page, "Sort by Score");
    const text = page.textContent ?? "";
    expect(text.indexOf("Al")).toBeLessThan(text.indexOf("Bo"));
    expect(text.indexOf("Bo")).toBeLessThan(text.indexOf("Cy"));
    expect(text).toContain("↑");
    expect(
      page
        .querySelector('rn-pressable[aria-label="Sorted by Score, ascending"]')
        ?.getAttribute("data-selected"),
    ).toBe("true");
  });

  it("gives the app's controls the table as shown, as CSV with formulas as TeX", () => {
    toolCalls.length = 0;
    const page = render(
      <TableToolsContext.Provider value={Tools}>
        <ChatMarkdown>{TABLE}</ChatMarkdown>
      </TableToolsContext.Provider>,
    );
    expect(toolCalls.at(-1)?.csv).toBe("Name,Score\nBo,10\nAl,9\nCy,x^2");
    press(page, "Sort by Name");
    expect(toolCalls.at(-1)?.csv).toBe("Name,Score\nAl,9\nBo,10\nCy,x^2");
    // The full screen view is the same table, still sortable.
    const expanded = render(toolCalls.at(-1)?.renderTable());
    expect(expanded.textContent).toContain("Cy");
    expect(page.querySelectorAll("b[data-csv]")).toHaveLength(1);
  });

  it("starts unsorted again when the columns change, and has no controls without the app's", () => {
    const first = render(<ChatMarkdown>{"| Name |\n| --- |\n| Bo |\n| Al |"}</ChatMarkdown>);
    expect(first.querySelector("b")).toBeNull();
    press(first, "Sort by Name");
    expect(headers(first)).toEqual(["Sorted by Name, ascending"]);
  });

  it("names a header without text by its position", () => {
    const copy: MarkdownCopy = { ...defaultMarkdownCopy, columnFallback: (i) => `col ${i}` };
    const page = render(
      <MarkdownCopyProvider copy={copy}>
        <ChatMarkdown>{"| | B |\n| --- | --- |\n| 1 | 2 |"}</ChatMarkdown>
      </MarkdownCopyProvider>,
    );
    expect(headers(page)).toEqual(["Sort by col 1", "Sort by B"]);
  });

  it("does not make body cells buttons", () => {
    const page = render(<ChatMarkdown>{TABLE}</ChatMarkdown>);
    expect(headers(page)).toHaveLength(2);
    expect(names(page).length).toBeGreaterThan(0);
  });
});
