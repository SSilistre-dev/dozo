// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, useContext } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({
  copy: undefined as import("@rakazo/chat-ui/native").MarkdownCopy | undefined,
  math: undefined as unknown,
  tools: undefined as unknown,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | { message?: string }, ...values: unknown[]) =>
      Array.isArray(strings)
        ? (strings as string[]).reduce((text, part, i) => `${text}${part}${values[i] ?? ""}`, "")
        : "",
  }),
}));
vi.mock("@lingui/core/macro", () => ({ plural: (count: number) => `plural:${count}` }));
vi.mock("@rakazo/chat-ui/native", async () => {
  const { createContext } = await import("react");
  const Formula = createContext<unknown>(null);
  const Tools = createContext<unknown>(null);
  const Copy = createContext<unknown>(null);
  return {
    MathViewContext: Formula,
    TableToolsContext: Tools,
    MarkdownCopyProvider: ({ copy, children }: { copy: unknown; children?: ReactNode }) =>
      createElement(Copy.Provider, { value: copy }, children),
    __contexts: { Math: Formula, Tools, Copy },
  };
});
vi.mock("../components/dozo-math-view", () => ({ MathView: () => null }));
vi.mock("../components/dozo-table-tools", () => ({ TableTools: () => null }));

import * as native from "@rakazo/chat-ui/native";
import { DozoMarkdownProviders } from "../components/dozo-markdown-providers";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it("gives chat Markdown the formula view, the table controls and the table's words", () => {
  const contexts = (native as unknown as { __contexts: Record<string, React.Context<unknown>> })
    .__contexts;
  function Probe() {
    seen.copy = useContext(contexts.Copy as React.Context<typeof seen.copy>);
    seen.math = useContext(contexts.Math as React.Context<unknown>);
    seen.tools = useContext(contexts.Tools as React.Context<unknown>);
    return null;
  }
  const container = document.createElement("div");
  act(() =>
    createRoot(container).render(
      <DozoMarkdownProviders>
        <Probe />
      </DozoMarkdownProviders>,
    ),
  );
  expect(typeof seen.math).toBe("function");
  expect(typeof seen.tools).toBe("function");
  const copy = seen.copy;
  expect(copy?.downloadCsv).toBe("Download CSV");
  expect(copy?.expandTable).toBe("Expand table");
  expect(copy?.closeTable).toBe("Close table");
  expect(copy?.sortBy("Name")).toBe("Sort by Name");
  expect(copy?.sortedBy("Name", "asc")).toBe("Sorted by Name, ascending");
  expect(copy?.sortedBy("Name", "desc")).toBe("Sorted by Name, descending");
  expect(copy?.columnFallback(2)).toBe("column 2");
  expect(copy?.columnDuplicate("A", 2)).toBe("A, column 2");
  expect(copy?.columnCollision("A")).toBe("A, empty");
  expect(copy?.pageOf(1, 3)).toBe("Page 1 of 3");
  expect(copy?.rowCount(2)).toBe("plural:2");
  expect(copy?.rowRange(1, 2, 3)).toBe("1–2 of 3 rows");
});
