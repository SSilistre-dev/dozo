// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ switcher: vi.fn() }));

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("../components/thread/header/chat-header-title", () => ({
  ChatHeaderTitle: ({ routeKey }: { routeKey: string }) =>
    createElement("b", { "data-title": routeKey }),
}));
vi.mock("../components/dozo-chat-switcher", () => ({
  DozoChatSwitcher: (props: object) => {
    api.switcher(props);
    return createElement("u", { "data-switcher": "" });
  },
}));

import { DozoChatHeaderTitle } from "../components/dozo-chat-header-title";

let root: Root;
let container: HTMLDivElement;
const render = (params: object) =>
  act(async () => root.render(createElement(DozoChatHeaderTitle, { routeKey: "route-1", params })));
const hasSwitcher = () => container.querySelector("[data-switcher]") !== null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.switcher.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("puts the switcher beside a bot chat's title, with the chat the route names", async () => {
  await render({ botId: "bot-1", name: "Ada", chatId: " c1 ", threadId: ["t1"] });
  expect(container.querySelector("[data-title]")!.getAttribute("data-title")).toBe("route-1");
  expect(hasSwitcher()).toBe(true);
  expect(api.switcher).toHaveBeenLastCalledWith({
    botId: "bot-1",
    chatId: "c1",
    threadId: "t1",
    name: "Ada",
  });
});

it("leaves a main chat's title as it was, only with the switcher beside it", async () => {
  await render({ botId: "bot-1" });
  expect(api.switcher).toHaveBeenLastCalledWith({
    botId: "bot-1",
    chatId: undefined,
    threadId: undefined,
    name: undefined,
  });
});

it("shows no switcher in a group, on an archived bot's chat, or without a bot", async () => {
  await render({ groupId: "group-1" });
  expect(hasSwitcher()).toBe(false);
  expect(container.querySelector("[data-title]")).not.toBeNull();
  await render({ botId: "bot-1", readOnly: "1" });
  expect(hasSwitcher()).toBe(false);
  await render({});
  expect(hasSwitcher()).toBe(false);
  expect(container.querySelector("[data-title]")).not.toBeNull();
});
