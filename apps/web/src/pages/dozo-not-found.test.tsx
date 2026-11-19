// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));

import { NotFoundPage } from "./dozo-not-found";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

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

it("lays the dragon faint behind upstream's page and adds no words", () => {
  act(() =>
    root.render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    ),
  );
  const page = container.querySelector('[data-rakazo-surface="not-found"]');
  expect(page?.textContent).toBe("404Page not foundGo home");
  expect(container.textContent).toBe(page?.textContent);
  const dragon = container.querySelector("svg[data-dozo-dragon]");
  const layer = dragon?.parentElement;
  expect(layer?.getAttribute("aria-hidden")).toBe("true");
  expect(layer?.className).toContain("pointer-events-none");
  expect(layer?.compareDocumentPosition(page as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(dragon?.getAttribute("class")).toContain("opacity-10");
  expect(dragon?.getAttribute("class")).toContain("text-foreground");
  // Upstream's own background would cover the figure; the wrapper paints it instead.
  expect(container.firstElementChild?.className).toContain(
    "[&>[data-rakazo-surface=not-found]]:bg-transparent",
  );
});

it("draws from the theme's tokens only, with nothing that moves", () => {
  const source = readFileSync(join(import.meta.dirname, "dozo-not-found.tsx"), "utf8");
  expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  expect(source).not.toMatch(/animate|<animate|transition/);
  expect(source).toContain('style={{ fill: "var(--dozo-seal)" }}');
  expect(source.match(/fill-background/g)?.length).toBe(2);
});
