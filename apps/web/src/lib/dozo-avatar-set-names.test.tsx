// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import {
  BotAvatarSetSchema,
  DEFAULT_NEW_BOT_AVATAR_SET,
  resolveBotAvatarSet,
} from "@rakazo/contracts";
import { messages as en } from "@rakazo/i18n/locales/en/messages.po";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { botAvatarSetName } from "@rakazo/i18n/run-error";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree only: the Turkish lines are in the fork's catalog block.

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { AvatarStudioPopover } from "../pages/shell/bots/avatar-studio-popover";

const repo = (path: string) => readFileSync(join(import.meta.dirname, "../../../..", path), "utf8");

beforeEach(() => {
  i18n.load({ en: en as Messages, tr: tr as Messages });
  i18n.activate("en");
});
afterEach(() => {
  document.body.replaceChildren();
});

it("names the two sets for what they are, in English and Turkish", () => {
  expect([botAvatarSetName("organic"), botAvatarSetName("rakazo")]).toEqual(["Character", "Simple"]);
  i18n.activate("tr");
  expect([botAvatarSetName("organic"), botAvatarSetName("rakazo")]).toEqual(["Karakter", "Sade"]);
});

it("says the English where no language is active yet", async () => {
  vi.resetModules();
  const fresh = await import("@rakazo/i18n/run-error");
  expect([fresh.botAvatarSetName("organic"), fresh.botAvatarSetName("rakazo")]).toEqual([
    "Character",
    "Simple",
  ]);
});

it("keeps the stored values: only the names changed", () => {
  expect(BotAvatarSetSchema.options).toEqual(["organic", "rakazo"]);
  expect(resolveBotAvatarSet("organic")).toBe("organic");
  expect(resolveBotAvatarSet("rakazo")).toBe("rakazo");
});

it("starts a new account and a new bot on Character, and an account with no saved choice too", () => {
  expect(DEFAULT_NEW_BOT_AVATAR_SET).toBe("organic");
  expect(resolveBotAvatarSet(undefined)).toBe("organic");
  expect(resolveBotAvatarSet(null)).toBe("organic");
  const schema = repo("packages/db/prisma/schema.prisma");
  expect(schema).toMatch(/botAvatarSet\s+String\s+@default\("organic"\)/);
  expect(schema).toMatch(/\bavatarSet\s+String\s+@default\("organic"\)/);
});

it("shows the same names on the Avatar Studio tabs", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as typeof window.matchMedia;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <AvatarStudioPopover
        value="#10B981"
        identity="sample-bot"
        avatarSet="organic"
        onChange={() => undefined}
      />,
    ),
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Customize bot avatar"]')?.click(),
  );
  const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
  expect(tabs).toEqual(expect.arrayContaining(["Character", "Simple"]));
  expect(tabs).not.toContain("Original");
  await act(async () => root.unmount());
});

it("takes every place that names a set from the one function", () => {
  for (const file of [
    "apps/web/src/pages/shell/bots/avatar-studio-popover.tsx",
    "apps/web/src/pages/settings/AccountSettingsOverlay.tsx",
    "apps/mobile/app/(settings)/general.tsx",
    "apps/mobile/app/bot-settings.tsx",
  ]) {
    const source = repo(file);
    expect(source, file).toContain("botAvatarSetName(");
    expect(source, file).not.toMatch(/Original<\/Trans>|t`Original`|t`Rakazo`|t`Dozo`/);
  }
});
