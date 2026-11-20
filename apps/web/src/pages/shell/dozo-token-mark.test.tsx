// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { DozoTokenMark } from "./dozo-token-mark";

it("shows a named key, with no words in the chat", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<DozoTokenMark />));
  expect(container.textContent).toBe("");
  expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
    "Sent with an access token",
  );
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
