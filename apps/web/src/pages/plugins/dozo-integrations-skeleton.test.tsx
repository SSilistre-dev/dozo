// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IntegrationRowsSkeleton } from "./dozo-integrations-skeleton";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("names itself as a busy status and draws the rows asked for", () => {
  act(() => root.render(<IntegrationRowsSkeleton label="Loading plugins…" rows={6} />));
  const status = host.querySelector('[role="status"]');
  expect(status?.getAttribute("aria-label")).toBe("Loading plugins…");
  expect(status?.getAttribute("aria-busy")).toBe("true");
  expect(status?.children).toHaveLength(6);
});
