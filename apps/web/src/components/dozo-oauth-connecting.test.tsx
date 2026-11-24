// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useOAuthPhase } from "../lib/dozo-oauth-phase";
import { DozoOAuthConnecting } from "./dozo-oauth-connecting";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

it("says it is connecting", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<DozoOAuthConnecting />));
  expect(container.textContent).toBe("Connecting…");
  act(() => root.unmount());
});

it("ending a submit only leaves connecting, never an attempt that is not connecting", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let phase!: ReturnType<typeof useOAuthPhase>;
  function Harness() {
    phase = useOAuthPhase();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  act(() => phase.setOauthSubmitting(false));
  expect([phase.oauthPending, phase.oauthSubmitting]).toEqual([false, false]);
  act(() => phase.setOauthPending(true));
  act(() => phase.setOauthSubmitting(false));
  expect([phase.oauthPending, phase.oauthSubmitting]).toEqual([true, false]);
  act(() => phase.setOauthSubmitting(true));
  expect([phase.oauthPending, phase.oauthSubmitting]).toEqual([true, true]);
  act(() => phase.setOauthSubmitting(false));
  expect([phase.oauthPending, phase.oauthSubmitting]).toEqual([true, false]);
  act(() => root.unmount());
});
