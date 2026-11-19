// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DozoKeyLink } from "./dozo-key-link";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("links the provider's key page in a new tab, named by its address", () => {
  act(() => root?.render(<DozoKeyLink provider="openrouter" />));
  const link = container.querySelector("a");
  expect(link?.getAttribute("href")).toBe("https://openrouter.ai/settings/keys");
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toBe("noreferrer");
  expect(link?.textContent).toBe("openrouter.ai");
});

it("shows nothing for a provider without a known key page", () => {
  act(() => root?.render(<DozoKeyLink provider="no-such-provider" />));
  expect(container.innerHTML).toBe("");
});
