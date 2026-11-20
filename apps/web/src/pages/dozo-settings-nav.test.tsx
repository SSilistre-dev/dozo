// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DozoSettingsNavGroups, dozoSettingsNavGroups, NOTICES_PAGE } from "./dozo-settings-nav";
import type { SettingsNavItem } from "./settings-nav";
import type { SettingsSection } from "./shell-overlay";

const capabilities = vi.hoisted(() => ({
  fetchAuthCapabilities: vi.fn<() => Promise<{ notices?: boolean }>>(async () => ({})),
}));
vi.mock("../lib/auth-capabilities", () => capabilities);

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

const Icon = () => null;
const item = (id: string): SettingsNavItem => ({
  id: id as SettingsSection,
  label: `${id[0]?.toUpperCase()}${id.slice(1)}`,
  icon: Icon,
});
// Upstream's nav order, every section available.
const ALL = [
  "general",
  "models",
  "confirmations",
  "vault",
  "wallet",
  "memory",
  "voice",
  "messaging",
  "computer",
  "labs",
  "usage",
  "billing",
  "organization",
  "updates",
].map(item);

const ids = (groups: ReturnType<typeof dozoSettingsNavGroups>) =>
  groups.map((group) => [group.id, group.items.map((entry) => entry.id)]);

it("groups the sections under Account, Bots and App in the design's order", () => {
  expect(ids(dozoSettingsNavGroups(ALL))).toEqual([
    ["account", ["general", "usage", "billing", "organization"]],
    [
      "bots",
      ["models", "confirmations", "vault", "wallet", "memory", "voice", "messaging", "computer"],
    ],
    ["app", ["labs", "updates"]],
  ]);
});

it("shows only the sections the deployment offers and leaves an empty group out", () => {
  const offered = ALL.filter(
    (entry) => !["labs", "updates", "billing", "wallet"].includes(entry.id),
  );
  expect(ids(dozoSettingsNavGroups(offered))).toEqual([
    ["account", ["general", "usage", "organization"]],
    ["bots", ["models", "confirmations", "vault", "memory", "voice", "messaging", "computer"]],
  ]);
});

it("puts a section it does not know yet under App instead of dropping it", () => {
  expect(ids(dozoSettingsNavGroups([item("general"), item("newthing")]))).toEqual([
    ["account", ["general"]],
    ["app", ["newthing"]],
  ]);
});

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.unstubAllGlobals();
});

/** No request of its own: the nav reads the capabilities the app already loaded. */
const fetchSpy = vi.fn<typeof fetch>(async () => new Response(null, { status: 500 }));

function render(section: SettingsSection, disabled = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchSpy);
  const container = document.createElement("nav");
  document.body.append(container);
  const root = createRoot(container);
  const onSectionChange = vi.fn();
  act(() =>
    root.render(
      <DozoSettingsNavGroups
        items={ALL.filter((entry) => entry.id !== "updates")}
        section={section}
        disabled={disabled}
        onSectionChange={onSectionChange}
      />,
    ),
  );
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, onSectionChange };
}

it("labels each group with its heading and keeps upstream's buttons, ids and current page", () => {
  const { container, onSectionChange } = render("usage");
  const groups = [...container.querySelectorAll("fieldset[data-dozo-settings-group]")];
  expect(
    groups.map(
      (group) => document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent,
    ),
  ).toEqual(["Account", "Bots", "App"]);
  const current = container.querySelectorAll('[aria-current="page"]');
  expect([...current].map((button) => button.getAttribute("data-testid"))).toEqual([
    "settings-nav-usage",
  ]);
  const vault = container.querySelector<HTMLButtonElement>('[data-testid="settings-nav-vault"]');
  expect(vault?.textContent).toBe("Vault");
  act(() => vault?.click());
  expect(onSectionChange).toHaveBeenCalledWith("vault");
  expect(container.querySelectorAll("button")).toHaveLength(13);
});

it("marks General while a space's page is open, and disables every button while a panel is busy", () => {
  const { container } = render("space" as SettingsSection, true);
  expect(container.querySelector('[aria-current="page"]')?.getAttribute("data-testid")).toBe(
    "settings-nav-general",
  );
  expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
});

it("links the third-party notices only where the server says it has them", async () => {
  capabilities.fetchAuthCapabilities.mockResolvedValueOnce({ notices: true });
  const local = render("general");
  await act(async () => {});
  const link = local.container.querySelector<HTMLAnchorElement>(
    '[data-testid="settings-nav-licenses"]',
  );
  expect(link?.getAttribute("href")).toBe(NOTICES_PAGE);
  expect(link?.textContent).toBe("Licenses");
  expect(link?.target).toBe("_blank");

  // A hosted server says nothing (or no): no link, and no request for a page it does not have.
  const hosted = render("general");
  capabilities.fetchAuthCapabilities.mockResolvedValueOnce({ notices: false });
  const refused = render("general");
  capabilities.fetchAuthCapabilities.mockRejectedValueOnce(new TypeError("offline"));
  const offline = render("general");
  await act(async () => {});
  for (const nav of [hosted, refused, offline]) {
    expect(nav.container.querySelector('[data-testid="settings-nav-licenses"]')).toBeNull();
  }
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("ignores an answer that arrives after the nav closed", async () => {
  const late = deferred<{ notices?: boolean }>();
  capabilities.fetchAuthCapabilities.mockReturnValueOnce(late.promise);
  render("general");
  for (const unmount of mounted.splice(0)) unmount();
  await act(async () => late.resolve({ notices: true }));
  expect(document.querySelector('[data-testid="settings-nav-licenses"]')).toBeNull();
});
