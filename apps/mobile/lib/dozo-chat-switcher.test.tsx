// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  chats: undefined as unknown[] | undefined,
  inboxBot: undefined as { name: string } | undefined,
  replace: vi.fn(),
  run: vi.fn(),
  pending: false,
  menu: {
    actions: [] as { id: string; title: string; state?: string; subactions?: unknown[] }[],
    title: "",
    press: (_id: string) => {},
  },
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (props: {
    actions: typeof api.menu.actions;
    title: string;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => {
    api.menu.actions = props.actions;
    api.menu.title = props.title;
    api.menu.press = (id) => props.onPressAction({ nativeEvent: { event: id } });
    return createElement("div", null, props.children);
  },
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ replace: api.replace }) }));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement("span", { "aria-label": accessibilityLabel }, children),
}));
vi.mock("./native", () => ({
  native: { secondaryLabel: "grey" },
  useResolvedAppearance: () => "dark",
}));
vi.mock("./search-inbox", () => ({ useInboxBot: () => api.inboxBot }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./dozo-bot-chats", () => ({
  dozoChatRoute: (botId: string, chatId: string, name: string) => ({
    pathname: "/thread",
    params: { botId, chatId, name },
  }),
  useDozoBotChats: () => api.chats,
  useDozoNewChat: () => ({ run: api.run, pending: api.pending }),
}));

import type { DozoBotChat } from "@rakazo/contracts";
import { DozoChatSwitcher, dozoChatSwitcherActions } from "../components/dozo-chat-switcher";

const chat = (id: string, name: string): DozoBotChat => ({
  id,
  botId: "bot-1",
  name,
  createdAt: "2026-11-21T17:41:00.000Z",
  archivedAt: null,
  unread: false,
  snoozedUntil: null,
});

let root: Root;
let container: HTMLDivElement;
const render = (props: { chatId?: string; threadId?: string; name?: string } = {}) =>
  act(async () => root.render(createElement(DozoChatSwitcher, { botId: "bot-1", ...props })));
const states = () =>
  api.menu.actions.map((action) => `${action.title}:${action.state ?? action.subactions?.length}`);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.chats = [chat("c1", "Launch plan"), chat("c2", "Taxes")];
  api.inboxBot = { name: "Ada" };
  api.pending = false;
  api.replace.mockReset();
  api.run.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("lists the bot's main chat, its extra chats and New chat, the main chat marked on a main chat", async () => {
  await render({ name: "Route Ada" });
  expect(states()).toEqual(["Ada:on", "Launch plan:off", "Taxes:off", ":1"]);
  expect(api.menu.title).toBe("Chats");
  expect(container.querySelector("[aria-label='Chats']")).not.toBeNull();
  const section = api.menu.actions[3]!.subactions as { title: string; image: string }[];
  expect(section[0]).toMatchObject({ title: "New chat", image: "plus" });
});

it("marks the extra chat on screen, by its chat id or the thread a notification named", async () => {
  await render({ chatId: "c2" });
  expect(states().slice(0, 3)).toEqual(["Ada:off", "Launch plan:off", "Taxes:on"]);
  await render({ threadId: "c1" });
  expect(states().slice(0, 3)).toEqual(["Ada:off", "Launch plan:on", "Taxes:off"]);
  // A thread the bot's list does not name is the main chat.
  await render({ threadId: "unknown" });
  expect(states()[0]).toBe("Ada:on");
});

it("names the bot from the route until the inbox has it, and falls back to the menu's own name", async () => {
  api.inboxBot = undefined;
  await render({ name: "Route Ada" });
  expect(api.menu.actions[0]!.title).toBe("Route Ada");
  await render();
  expect(api.menu.actions[0]!.title).toBe("Chats");
});

it("is the main chat and New chat alone until the list is read", async () => {
  api.chats = undefined;
  await render();
  expect(states()).toEqual(["Ada:on", ":1"]);
});

it("switches to an extra chat by replacing the chat on screen, never by stacking one", async () => {
  await render();
  act(() => api.menu.press("chat:c2"));
  expect(api.replace).toHaveBeenCalledExactlyOnceWith({
    pathname: "/thread",
    params: { botId: "bot-1", chatId: "c2", name: "Ada" },
  });
});

it("switches back to the main chat without a chat id, and does nothing for the chat already open", async () => {
  await render({ chatId: "c1" });
  act(() => api.menu.press("chat:c1"));
  expect(api.replace).not.toHaveBeenCalled();
  act(() => api.menu.press("main"));
  expect(api.replace).toHaveBeenCalledExactlyOnceWith({
    pathname: "/thread",
    params: { botId: "bot-1", name: "Ada" },
  });
  api.replace.mockClear();
  await render();
  act(() => api.menu.press("main"));
  expect(api.replace).not.toHaveBeenCalled();
});

it("makes a new chat from New chat, once at a time, and ignores an id it does not know", async () => {
  await render();
  act(() => api.menu.press("new"));
  expect(api.run).toHaveBeenCalledExactlyOnceWith(undefined);
  act(() => api.menu.press("something-else"));
  expect(api.replace).not.toHaveBeenCalled();
  api.pending = true;
  await render();
  const section = api.menu.actions[3]!.subactions as { attributes: { disabled: boolean } }[];
  expect(section[0]!.attributes.disabled).toBe(true);
});

it("builds the rows from plain data", () => {
  const rows = dozoChatSwitcherActions("Ada", [chat("c1", "Launch plan")], "c1", {
    label: "New chat",
    disabled: false,
  });
  expect(rows.map((row) => row.id)).toEqual(["main", "chat:c1", "new-chat-section"]);
});
