// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ComponentType, ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each module answers only once the test lets it, so "nothing yet" and "loaded" can be told apart.
const loading = vi.hoisted(() => ({
  gate: undefined as undefined | Promise<void>,
  module:
    (...names: string[]) =>
    async () => {
      await loading.gate;
      const { createElement: element } = await import("react");
      return Object.fromEntries(
        names.map((name) => [
          name,
          (props: object) => element("p", { "data-stub": name }, JSON.stringify(props)),
        ]),
      );
    },
}));
vi.mock("../pages/shell/dozo-avatar-generate-panel", loading.module("DozoAvatarGeneratePanel"));
vi.mock("../pages/model-settings/dozo-cli-accounts", loading.module("DozoCliAccounts"));
vi.mock("../pages/shell/dozo-site-sessions", loading.module("SiteSessionsControl"));
vi.mock("../pages/shell/dozo-bot-skills-section", loading.module("DozoBotSkillsSection"));
vi.mock("../pages/shell/dozo-own-computer-row", loading.module("OwnComputerRow"));
vi.mock(
  "../pages/dozo-organization-library-switch",
  loading.module("DozoOrganizationLibrarySwitch", "DozoLibraryBadge", "DozoHiddenLibrarySkills"),
);
vi.mock("../pages/shell/dozo-bot-backups", loading.module("DozoBotBackups"));
vi.mock("../components/teach/dozo-skill-draft-card", loading.module("SkillDraftCard"));
vi.mock("../components/teach/dozo-teach-capture-overlay", loading.module("TeachCaptureOverlay"));
vi.mock("../components/dozo-announcement-lines", loading.module("DozoAnnouncementLines"));
vi.mock(
  "../pages/shell/dozo-message-pins",
  loading.module("DozoPinMenuItem", "DozoPinnedMessages"),
);
vi.mock("../pages/shell/dozo-message-extensions", loading.module("DozoMessageMenuItems"));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import {
  DozoAnnouncementLines,
  DozoAvatarGeneratePanel,
  DozoBotBackups,
  DozoBotSkillsSection,
  DozoCliAccounts,
  DozoHiddenLibrarySkills,
  DozoLibraryBadge,
  DozoOrganizationLibrarySwitch,
  DozoPinMenuItem,
  DozoPinnedMessages,
  OwnComputerRow,
  preloadDozoSurfaces,
  SiteSessionsControl,
  SkillDraftCard,
  TeachCaptureOverlay,
} from "./dozo-lazy-surfaces";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  loading.gate = undefined;
});

describe("the fork's screens that load when first shown", () => {
  const screens: Array<[string, ComponentType<never>]> = [
    ["DozoAvatarGeneratePanel", DozoAvatarGeneratePanel],
    ["DozoCliAccounts", DozoCliAccounts],
    ["SiteSessionsControl", SiteSessionsControl],
    ["DozoBotSkillsSection", DozoBotSkillsSection],
    ["OwnComputerRow", OwnComputerRow],
    ["DozoOrganizationLibrarySwitch", DozoOrganizationLibrarySwitch],
    ["DozoLibraryBadge", DozoLibraryBadge],
    ["DozoHiddenLibrarySkills", DozoHiddenLibrarySkills],
    ["DozoBotBackups", DozoBotBackups],
    ["SkillDraftCard", SkillDraftCard],
    ["DozoAnnouncementLines", DozoAnnouncementLines],
    ["DozoPinMenuItem", DozoPinMenuItem],
    ["DozoPinnedMessages", DozoPinnedMessages],
  ];

  // The badge and the hidden list come from the same file as the switch, loaded by the time they run.
  const sharesCode = new Set(["DozoLibraryBadge", "DozoHiddenLibrarySkills", "DozoPinnedMessages"]);
  // These take no props, so none reach the screen.
  const takesNone = new Set([
    "DozoCliAccounts",
    "DozoLibraryBadge",
    "DozoHiddenLibrarySkills",
    "DozoAnnouncementLines",
  ]);

  for (const [name, Screen] of screens) {
    it(`${name} draws nothing while its code is on its way, then the screen with its props`, async () => {
      const release = deferred();
      loading.gate = release.promise;
      await act(async () => root.render(createElement(Screen, { id: "a" } as never)));
      if (sharesCode.has(name)) {
        await vi.waitFor(() => expect(host.querySelector(`[data-stub="${name}"]`)).not.toBeNull());
        expect(host.querySelector(`[data-stub="${name}"]`)?.textContent).toBe(
          takesNone.has(name) ? "{}" : '{"id":"a"}',
        );
        return;
      }
      // Nothing, except the skills section, which keeps its room so what is below it stays put.
      expect(host.querySelector("[data-stub]")).toBeNull();
      expect(host.querySelector("[data-dozo-skills-room]") !== null).toBe(
        name === "DozoBotSkillsSection",
      );
      release.resolve();
      await vi.waitFor(() => expect(host.querySelector(`[data-stub="${name}"]`)).not.toBeNull());
      expect(host.querySelector("[data-dozo-skills-room]")).toBeNull();
      expect(host.querySelector(`[data-stub="${name}"]`)?.textContent).toBe(
        takesNone.has(name) ? "{}" : '{"id":"a"}',
      );
    });
  }
});

it("draws the fork's other message items after Pin, with the same props", async () => {
  await act(async () => root.render(createElement(DozoPinMenuItem, { id: "a" } as never)));
  await vi.waitFor(() =>
    expect(
      [...host.querySelectorAll("[data-stub]")].map((node) => node.getAttribute("data-stub")),
    ).toEqual(["DozoPinMenuItem", "DozoMessageMenuItems"]),
  );
  expect(host.querySelector('[data-stub="DozoMessageMenuItems"]')?.textContent).toBe('{"id":"a"}');
});

describe("the teaching capture overlay", () => {
  it("is not even fetched while nothing is being recorded", async () => {
    await act(async () =>
      root.render(createElement(TeachCaptureOverlay, { enabled: false, botId: "b" } as never)),
    );
    expect(host.innerHTML).toBe("");
  });

  it("draws with its props once a recording starts", async () => {
    await act(async () =>
      root.render(createElement(TeachCaptureOverlay, { enabled: true, botId: "b" } as never)),
    );
    await vi.waitFor(() =>
      expect(host.querySelector('[data-stub="TeachCaptureOverlay"]')?.textContent).toBe(
        '{"enabled":true,"botId":"b"}',
      ),
    );
  });
});

it("is fetched ahead, all of them, for the idle moment after the page has drawn", async () => {
  await expect(preloadDozoSurfaces()).resolves.toHaveLength(12);
});
