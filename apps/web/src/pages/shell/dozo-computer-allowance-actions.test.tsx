// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ComputerAllowanceActions } from "./dozo-computer-allowance-actions";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onUpgrade = vi.fn();

function Where() {
  return <output data-testid="where">{useLocation().search}</output>;
}

function show(props: { upgrade: string | null; ownDevice: boolean }) {
  act(() =>
    root.render(
      <I18nProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/app?bot=b1"]}>
          <ComputerAllowanceActions {...props} onUpgrade={onUpgrade} />
          <Where />
        </MemoryRouter>
      </I18nProvider>,
    ),
  );
}

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onUpgrade.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("Free: Upgrade first, then the member's own devices, opened in Settings", () => {
  show({ upgrade: "Yükselt", ownDevice: true });
  const actions = [...host.querySelectorAll("button, a")];
  expect(actions.map((node) => node.textContent)).toEqual(["Yükselt", "Your devices"]);
  act(() => (actions[0] as HTMLElement).click());
  expect(onUpgrade).toHaveBeenCalledOnce();
  act(() => (actions[1] as HTMLElement).click());
  expect(host.querySelector('[data-testid="where"]')?.textContent).toBe(
    "?bot=b1&settings=computer",
  );
});

it("a member who cannot upgrade still gets the devices; a paid plan gets only Upgrade", () => {
  show({ upgrade: null, ownDevice: true });
  expect([...host.querySelectorAll("button, a")].map((node) => node.textContent)).toEqual([
    "Your devices",
  ]);
  show({ upgrade: "Yükselt", ownDevice: false });
  expect([...host.querySelectorAll("button, a")].map((node) => node.textContent)).toEqual([
    "Yükselt",
  ]);
});
