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

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import {
  DozoAvatarGeneratePanel,
  DozoBotBackups,
  DozoBotSkillsSection,
  DozoCliAccounts,
  DozoHiddenLibrarySkills,
  DozoLibraryBadge,
  DozoOrganizationLibrarySwitch,
  OwnComputerRow,
  preloadDozoSurfaces,
  SiteSessionsControl,
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
  ];

  // The badge and the hidden list come from the same file as the switch, loaded by the time they run.
  const sharesCode = new Set(["DozoLibraryBadge", "DozoHiddenLibrarySkills"]);

  for (const [name, Screen] of screens) {
    it(`${name} draws nothing while its code is on its way, then the screen with its props`, async () => {
      const release = deferred();
      loading.gate = release.promise;
      await act(async () => root.render(createElement(Screen, { id: "a" } as never)));
      if (sharesCode.has(name)) {
        await vi.waitFor(() => expect(host.querySelector(`[data-stub="${name}"]`)).not.toBeNull());
        expect(host.querySelector(`[data-stub="${name}"]`)?.textContent).toBe('{"id":"a"}');
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
        name === "DozoCliAccounts" ? "{}" : '{"id":"a"}',
      );
    });
  }
});

it("is fetched ahead, all of them, for the idle moment after the page has drawn", async () => {
  await expect(preloadDozoSurfaces()).resolves.toHaveLength(6);
});
