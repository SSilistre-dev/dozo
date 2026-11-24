// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  push: vi.fn(),
  opener: vi.fn(() => true),
  open: vi.fn(),
  menuFor: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: api.push }) }));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children }: { children?: ReactNode }) => createElement("em", null, children),
  View: ({ children, style }: { children?: ReactNode; style?: { paddingLeft?: number } }) =>
    createElement("span", { "data-indent": style?.paddingLeft }, children),
}));
vi.mock("./native", () => ({
  native: { secondaryLabel: "grey", label: "black", fillPressed: "pressed" },
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./ripple", () => ({ androidRipple: () => undefined }));
vi.mock("../components/home-styles", () => ({
  INBOX_ROW: { padding: 16, gap: 12, avatarSize: 62 },
  COMPACT_INBOX_ROW: { padding: 12, gap: 10 },
  createHomeStyles: () => ({ rowPressed: "pressed", unreadDot: "dot" }),
}));
vi.mock("../components/drag-safe-pressable", () => ({
  DragSafePressable: (props: {
    accessibilityLabel: string;
    accessibilityState: { selected: boolean };
    accessibilityActions: { name: string; label: string }[];
    onAccessibilityAction: () => void;
    onPress: () => void;
    onLongPress: () => void;
    children?: ReactNode;
  }) =>
    createElement(
      "button",
      {
        "aria-label": props.accessibilityLabel,
        "aria-selected": props.accessibilityState.selected,
        "data-action": props.accessibilityActions.map((action) => action.label).join(),
        onClick: props.onPress,
        onContextMenu: props.onLongPress,
        onKeyDown: props.onAccessibilityAction,
      },
      props.children,
    ),
}));
vi.mock("../components/inbox-rows", async () => {
  const { createContext } = await import("react");
  return {
    CompactRowsContext: createContext(false),
    SelectedChatContext: createContext<string | null>(null),
  };
});
vi.mock("./inbox-changes", () => ({ openChatFromInbox: api.opener }));
vi.mock("./dozo-bot-chats", () => ({
  dozoChatRoute: (botId: string, chatId: string, name: string) => ({
    pathname: "/thread",
    params: { botId, chatId, name },
  }),
  useDozoChatMenu: (botId: string) => {
    api.menuFor(botId);
    return { open: api.open, dialog: createElement("i", { "data-dialog": "" }) };
  },
}));

import type { DozoBotChat } from "@rakazo/contracts";
import { DozoInboxChatRow } from "../components/dozo-inbox-chat-row";
import { CompactRowsContext, SelectedChatContext } from "../components/inbox-rows";
import type { MobileBot } from "./mobile-types";

const bot = { id: "bot-1", name: "Ada" } as MobileBot;
const chat = (overrides: Partial<DozoBotChat> = {}): DozoBotChat => ({
  id: "chat-1",
  botId: "bot-1",
  name: "Launch plan",
  createdAt: "2026-11-21T17:41:00.000Z",
  archivedAt: null,
  unread: false,
  snoozedUntil: null,
  ...overrides,
});

let root: Root;
let container: HTMLDivElement;
const render = (entry = chat(), context: { compact?: boolean; selected?: string | null } = {}) =>
  act(async () =>
    root.render(
      createElement(
        CompactRowsContext.Provider,
        { value: context.compact ?? false },
        createElement(
          SelectedChatContext.Provider,
          { value: context.selected ?? null },
          createElement(DozoInboxChatRow, { bot, chat: entry }),
        ),
      ),
    ),
  );
const button = () => container.querySelector("button")!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [api.push, api.opener, api.open, api.menuFor]) mock.mockClear();
  api.opener.mockReturnValue(true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("shows the chat's name, in line with the bot's name, without a dot while it is read", async () => {
  await render();
  expect(container.textContent).toBe("Launch plan");
  expect(button().getAttribute("aria-label")).toBe("Launch plan");
  expect(container.querySelector("[data-indent]")!.getAttribute("data-indent")).toBe("90");
  expect(button().getAttribute("data-action")).toBe("More");
});

it("indents less in a narrow pane, where the bot's own row is tighter", async () => {
  await render(chat(), { compact: true });
  expect(container.querySelector("[data-indent]")!.getAttribute("data-indent")).toBe("84");
});

it("says that a chat is unread by its own dot and label", async () => {
  await render(chat({ unread: true }));
  expect(button().getAttribute("aria-label")).toBe("Launch plan (unread)");
  expect(container.querySelectorAll("span span").length).toBe(1);
});

it("marks the chat that is open beside the list, and no other", async () => {
  await render(chat(), { selected: "chat-1" });
  expect(button().getAttribute("aria-selected")).toBe("true");
  await render(chat(), { selected: "bot-1" });
  expect(button().getAttribute("aria-selected")).toBe("false");
});

it("opens the chat on its own route, through the inbox so a wide window replaces the open chat", async () => {
  await render();
  act(() => button().click());
  expect(api.opener).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { botId: "bot-1", chatId: "chat-1", name: "Ada" },
  });
  expect(api.push).not.toHaveBeenCalled();
});

it("pushes the route itself when no inbox is there to open it", async () => {
  api.opener.mockReturnValue(false);
  await render();
  act(() => button().click());
  expect(api.push).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { botId: "bot-1", chatId: "chat-1", name: "Ada" },
  });
});

it("opens that chat's sheet on a long press or the row's action, never the bot's", async () => {
  const entry = chat({ unread: true });
  await render(entry);
  expect(api.menuFor).toHaveBeenCalledWith("bot-1");
  act(() => void button().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  expect(api.open).toHaveBeenLastCalledWith(entry, false);
  act(() => void button().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true })));
  expect(api.open).toHaveBeenCalledTimes(2);
  // The rename prompt goes with the row.
  expect(container.querySelector("[data-dialog]")).not.toBeNull();
});
