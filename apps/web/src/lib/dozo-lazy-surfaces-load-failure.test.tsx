// @vitest-environment jsdom
import type { ComponentType, ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Every screen's code is gone, as after a deploy that removed it or on a dropped connection.
vi.mock("../pages/shell/dozo-avatar-generate-panel", () => {
  throw new Error("chunk gone");
});
vi.mock("../pages/model-settings/dozo-cli-accounts", () => {
  throw new Error("chunk gone");
});
vi.mock("../pages/shell/dozo-site-sessions", () => {
  throw new Error("chunk gone");
});
vi.mock("../pages/shell/dozo-bot-skills-section", () => {
  throw new Error("chunk gone");
});
vi.mock("../pages/shell/dozo-own-computer-row", () => {
  throw new Error("chunk gone");
});
vi.mock("../pages/dozo-organization-library-switch", () => {
  throw new Error("chunk gone");
});
vi.mock("../components/teach/dozo-skill-draft-card", () => {
  throw new Error("chunk gone");
});
vi.mock("../components/teach/dozo-teach-capture-overlay", () => {
  throw new Error("chunk gone");
});
vi.mock("../components/dozo-announcement-lines", () => {
  throw new Error("chunk gone");
});
vi.mock("../pages/shell/dozo-message-pins", () => {
  throw new Error("chunk gone");
});
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import {
  DozoAnnouncementLines,
  DozoAvatarGeneratePanel,
  DozoBotSkillsSection,
  DozoCliAccounts,
  DozoHiddenLibrarySkills,
  DozoLibraryBadge,
  DozoOrganizationLibrarySwitch,
  DozoPinMenuItem,
  DozoPinnedMessages,
  OwnComputerRow,
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
});

const screens: Array<[string, ComponentType<never>]> = [
  ["DozoAvatarGeneratePanel", DozoAvatarGeneratePanel],
  ["SiteSessionsControl", SiteSessionsControl],
  ["DozoBotSkillsSection", DozoBotSkillsSection],
  ["OwnComputerRow", OwnComputerRow],
  ["DozoOrganizationLibrarySwitch", DozoOrganizationLibrarySwitch],
  ["SkillDraftCard", SkillDraftCard],
];

for (const [name, Screen] of screens) {
  it(`${name} leaves the panel's own line in its place and the rest of the page standing`, async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () =>
      root.render(
        createElement("main", null, [
          createElement("p", { key: "chat", "data-shell": true }, "the chat"),
          createElement(Screen, { key: "screen" } as never),
        ]),
      ),
    );
    await vi.waitFor(() => expect(host.textContent).toContain("Could not load"));
    expect(host.querySelector("[data-shell]")?.textContent).toBe("the chat");
    quiet.mockRestore();
  });
}

it("DozoCliAccounts, which is nothing on most servers, stays nothing and leaves the page standing", async () => {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await act(async () =>
    root.render(
      createElement("main", null, [
        createElement("p", { key: "chat", "data-shell": true }, "the chat"),
        createElement(DozoCliAccounts, { key: "screen" }),
      ]),
    ),
  );
  await vi.waitFor(() => expect(quiet).toHaveBeenCalled());
  expect(host.textContent).toBe("the chat");
  quiet.mockRestore();
});

it.each([
  ["DozoLibraryBadge", DozoLibraryBadge],
  ["DozoHiddenLibrarySkills", DozoHiddenLibrarySkills],
  ["DozoAnnouncementLines", DozoAnnouncementLines],
  ["DozoPinMenuItem", DozoPinMenuItem],
  ["DozoPinnedMessages", DozoPinnedMessages],
] as Array<[string, ComponentType<never>]>)(
  "%s, a label beside the skills, stays nothing and leaves the page standing",
  async (_name, Screen) => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () =>
      root.render(
        createElement("main", null, [
          createElement("p", { key: "chat", "data-shell": true }, "the chat"),
          createElement(Screen, { key: "screen" } as never),
        ]),
      ),
    );
    await vi.waitFor(() => expect(quiet).toHaveBeenCalled());
    expect(host.textContent).toBe("the chat");
    quiet.mockRestore();
  },
);

it("TeachCaptureOverlay leaves the computer window's own line in its place while recording", async () => {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await act(async () =>
    root.render(
      createElement("main", null, [
        createElement("p", { key: "chat", "data-shell": true }, "the chat"),
        createElement(TeachCaptureOverlay, { key: "screen", enabled: true } as never),
      ]),
    ),
  );
  await vi.waitFor(() => expect(host.textContent).toContain("Could not load"));
  expect(host.querySelector("[data-shell]")?.textContent).toBe("the chat");
  quiet.mockRestore();
});
