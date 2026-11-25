// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => (
    <div role="img" aria-label={accessibilityLabel}>
      {children}
    </div>
  ),
}));
vi.mock("./native/native", () => ({ useMobileTokens: () => ({ mutedForeground: "muted" }) }));
vi.mock("../components/native/native-symbol", () => ({
  NativeSymbol: ({ ios, color }: { ios: string; color: string }) => (
    <i data-symbol={ios} data-color={color} />
  ),
}));

import { DozoTokenMark } from "../components/thread/dozo-token-mark";

it("shows a muted key named for screen readers, with no words", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<DozoTokenMark />));
  expect(container.textContent).toBe("");
  expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
    "Sent with an access token",
  );
  expect(container.querySelector("i")?.dataset).toMatchObject({ symbol: "key", color: "muted" });
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
