// @vitest-environment jsdom
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./AdminAccessPage", () => ({
  AccessGrantsPanel: () => <div data-testid="grants-panel" />,
}));
vi.mock("./PluginSubmissionsPanel", () => ({
  PluginSubmissionsPanel: () => <div data-testid="plugins-panel" />,
}));

import { DOZO_ADMIN_NAV } from "./dozo-admin-nav";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([
  ["access", "grants-panel"],
  ["plugins", "plugins-panel"],
])(
  "opens upstream's %s panel as a section of the admin page, without its own page",
  async (path, testId) => {
    const Page = DOZO_ADMIN_NAV.find((section) => section.path === path)?.page;
    expect(Page).toBeTruthy();
    if (!Page) return;
    await act(async () => {
      root.render(
        <Suspense fallback={null}>
          <Page />
        </Suspense>,
      );
    });
    await vi.waitFor(() =>
      expect(container.querySelector(`[data-testid="${testId}"]`)).toBeTruthy(),
    );
  },
);

it("lists free access only on a server that bills, and every other section always", () => {
  expect(
    DOZO_ADMIN_NAV.filter((section) => section.billing).map((section) => section.path),
  ).toEqual(["access"]);
});
