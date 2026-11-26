// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { registerPushToken } = vi.hoisted(() => ({
  registerPushToken: vi.fn(async () => undefined),
}));
vi.mock("./notifications/push", () => ({ registerPushToken }));

import { usePushWhenAccountHasBot } from "./dozo-push-on-first-bot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;

function Probe({ enabled, hasBot }: { enabled: boolean; hasBot: boolean }) {
  usePushWhenAccountHasBot(enabled, hasBot);
  return null;
}

function show(enabled: boolean, hasBot: boolean) {
  act(() => root.render(<Probe enabled={enabled} hasBot={hasBot} />));
}

beforeEach(() => {
  registerPushToken.mockClear();
  root = createRoot(document.createElement("div"));
});

afterEach(() => act(() => root.unmount()));

it("asks for nothing while the account has no bot, and once when it gets one", () => {
  show(true, false);
  show(true, false);
  expect(registerPushToken).not.toHaveBeenCalled();
  show(true, true);
  show(true, true);
  expect(registerPushToken).toHaveBeenCalledOnce();
});

it("asks for nothing while signed out or choosing a share target", () => {
  show(false, true);
  expect(registerPushToken).not.toHaveBeenCalled();
});
