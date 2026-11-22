// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ComponentType } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each module answers only once the test lets it, so "nothing yet" and "loaded" can be told apart.
const loading = vi.hoisted(() => ({
  gate: undefined as undefined | Promise<void>,
  module: (name: string) => async () => {
    await loading.gate;
    const { createElement: element } = await import("react");
    return {
      [name]: (props: object) => element("p", { "data-stub": name }, JSON.stringify(props)),
    };
  },
}));
vi.mock("../components/teach/dozo-skill-draft-card", loading.module("SkillDraftCard"));
vi.mock("../pages/shell/dozo-site-sessions", loading.module("SiteSessionsControl"));
vi.mock("../pages/shell/dozo-bot-skills-section", loading.module("DozoBotSkillsSection"));
vi.mock("../pages/shell/dozo-own-computer-row", loading.module("OwnComputerRow"));

import {
  DozoBotSkillsSection,
  OwnComputerRow,
  SiteSessionsControl,
  SkillDraftCard,
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
});

describe("the fork's screens that load when first shown", () => {
  const screens: Array<[string, ComponentType<never>]> = [
    ["SkillDraftCard", SkillDraftCard],
    ["SiteSessionsControl", SiteSessionsControl],
    ["DozoBotSkillsSection", DozoBotSkillsSection],
    ["OwnComputerRow", OwnComputerRow],
  ];

  for (const [name, Screen] of screens) {
    it(`${name} draws nothing while its code is on its way, then the screen with its props`, async () => {
      const release = deferred();
      loading.gate = release.promise;
      await act(async () => root.render(createElement(Screen, { id: "a" } as never)));
      expect(host.innerHTML).toBe("");
      release.resolve();
      await vi.waitFor(() => expect(host.querySelector(`[data-stub="${name}"]`)).not.toBeNull());
      expect(host.querySelector(`[data-stub="${name}"]`)?.textContent).toBe('{"id":"a"}');
    });
  }
});
