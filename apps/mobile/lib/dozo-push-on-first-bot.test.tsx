// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { registerPushToken, permission } = vi.hoisted(() => ({
  registerPushToken: vi.fn(async () => undefined),
  permission: { granted: false },
}));
vi.mock("./notifications/push", () => ({ registerPushToken }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ granted: permission.granted }),
}));

import { usePushWhenAccountHasBot } from "./dozo-push-on-first-bot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;

function Probe({ enabled, hasBot }: { enabled: boolean; hasBot: boolean }) {
  usePushWhenAccountHasBot(enabled, hasBot);
  return null;
}

async function show(enabled: boolean, hasBot: boolean) {
  await act(async () => {
    root.render(<Probe enabled={enabled} hasBot={hasBot} />);
    await flush();
  });
}

beforeEach(() => {
  registerPushToken.mockClear();
  permission.granted = false;
  root = createRoot(document.createElement("div"));
});

afterEach(() => act(() => root.unmount()));

it("asks for nothing while the account has no bot, and once when it gets one", async () => {
  await show(true, false);
  await show(true, false);
  expect(registerPushToken).not.toHaveBeenCalled();
  await show(true, true);
  await show(true, true);
  expect(registerPushToken).toHaveBeenCalledOnce();
});

it("asks for nothing while signed out or choosing a share target", async () => {
  await show(false, true);
  expect(registerPushToken).not.toHaveBeenCalled();
});

it("registers a device that allowed notifications without waiting for a bot, once", async () => {
  permission.granted = true;
  await show(true, false);
  expect(registerPushToken).toHaveBeenCalledOnce();
  await show(true, true);
  expect(registerPushToken).toHaveBeenCalledOnce();
});

it("waits for a bot again after signing out and into an account without one", async () => {
  await show(true, true);
  await show(false, true);
  await show(true, false);
  expect(registerPushToken).toHaveBeenCalledOnce();
});

it("is what the inbox calls, with the account's bots in place of upstream's effect", () => {
  const inbox = readFileSync(join(import.meta.dirname, "../app/index.tsx"), "utf8");
  expect(inbox).toContain(
    "usePushWhenAccountHasBot(\n    hasSession && !onShareSelect,\n    bots.length > 0 || spaces.some((space) => space.bots.length > 0),\n  );",
  );
  expect(inbox).not.toContain("registerPushToken");
});
