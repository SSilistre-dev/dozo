// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChatMarkdown } from "./markdown.web";

const load = vi.hoisted(() => ({ tries: 0 }));
vi.mock("katex", () => {
  load.tries += 1;
  throw new Error("chunk failed to load");
});

it("keeps a formula as its source when KaTeX cannot load", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ChatMarkdown>{"Area $\\pi r^2$"}</ChatMarkdown>);
  });
  await vi.waitFor(() => expect(load.tries).toBeGreaterThan(0));
  expect(container.querySelector(".rk-math-source")?.textContent).toBe("$\\pi r^2$");
  expect(container.querySelector(".katex")).toBeNull();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
