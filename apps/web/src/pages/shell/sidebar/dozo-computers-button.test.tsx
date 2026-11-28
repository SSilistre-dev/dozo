// @vitest-environment jsdom
import type { ComponentProps, ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const opened = vi.hoisted(() => vi.fn());
vi.mock("../../dozo-surfaces", () => ({ openDozoSurface: opened }));
vi.mock("../../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactElement }) => children,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & Record<string, string>) => <button type="button" {...props} />,
}));

import { DozoComputersButton } from "./dozo-computers-button";

it("opens the computers wall", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<DozoComputersButton />));
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Computers"]');
  await act(async () => button?.click());
  expect(opened).toHaveBeenCalledExactlyOnceWith("computers");
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
