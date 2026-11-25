// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  chats: undefined as unknown[] | undefined,
  push: vi.fn(),
  open: vi.fn(),
  now: Date.parse("2026-11-22T12:00:00.000Z"),
  tick: undefined as number | null | undefined,
  pins: {} as Record<string, unknown[] | undefined>,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("@rakazo/chat-ui/hooks", () => ({
  useNow: (ms: number | null) => {
    api.tick = ms;
    return api.now;
  },
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: api.push }) }));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("./appearance/appearance", () => ({ mobileTokens: () => ({ unread: "#006CEB" }) }));
vi.mock("./dozo-message-actions", () => ({
  useDozoPins: (threadId: string) => api.pins[threadId],
}));
vi.mock("./inbox", () => ({ formatSnoozeWake: (iso: string) => `wakes ${iso}` }));
vi.mock("./dozo-bot-chats", () => ({
  dozoChatRoute: (botId: string, chatId: string, name: string) => ({
    pathname: "/thread",
    params: { botId, chatId, name },
  }),
  useDozoBotChats: () => api.chats,
  useDozoChatMenu: () => ({
    open: api.open,
    dialog: createElement("i", { "data-dialog": "" }),
  }),
}));
vi.mock("../components/settings/settings-group", () => ({
  SettingsGroup: ({ label, children }: { label?: string; children?: ReactNode }) =>
    createElement("section", { "aria-label": label }, children),
  SettingsRow: (props: {
    title: string;
    value?: string;
    dimmed?: boolean;
    trailing?: ReactNode;
    accessibilityLabel?: string;
    accessibilityActions?: { name: string; label: string }[];
    onAccessibilityAction?: () => void;
    onPress: () => void;
    onLongPress: () => void;
  }) =>
    createElement(
      "div",
      {
        "data-row": props.title,
        "aria-label": props.accessibilityLabel,
        "data-dimmed": props.dimmed ? "" : undefined,
        "data-action": props.accessibilityActions?.map((action) => action.label).join(),
        onClick: props.onPress,
        onContextMenu: props.onLongPress,
        onKeyDown: props.onAccessibilityAction,
      },
      props.title,
      props.value ? createElement("small", null, props.value) : null,
      props.trailing,
    ),
}));

import { DozoBotChatsGroup } from "../components/dozo-bot-chats-group";

const chat = (id: string, overrides: object = {}) => ({
  id,
  botId: "bot-1",
  name: `Chat ${id}`,
  createdAt: "2026-11-21T17:41:00.000Z",
  archivedAt: null,
  unread: false,
  snoozedUntil: null,
  ...overrides,
});

let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(createElement(DozoBotChatsGroup, { botId: "bot-1", botName: "Ada" })),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(api.now);
  api.chats = undefined;
  api.push.mockReset();
  api.open.mockReset();
  api.tick = undefined;
  api.pins = {};
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A bot without extra chats is as it was: nothing of this is on its profile.
it("adds nothing to the profile of a bot with no extra chats", async () => {
  await render();
  expect(container.innerHTML).toBe("");
  api.chats = [];
  await render();
  expect(container.innerHTML).toBe("");
  expect(api.tick).toBeNull();
});

it("lists the bot's chats under Chats, each with its own unread dot", async () => {
  api.chats = [chat("a"), chat("b", { unread: true })];
  await render();
  expect(container.querySelector("section")?.getAttribute("aria-label")).toBe("Chats");
  const rows = [...container.querySelectorAll("[data-row]")];
  expect(rows.map((row) => row.getAttribute("data-row"))).toEqual(["Chat a", "Chat b"]);
  expect(rows[0]!.getAttribute("aria-label")).toBe("Chat a");
  expect(rows[1]!.getAttribute("aria-label")).toBe("Chat b (unread)");
  expect(rows[0]!.querySelector("span")).toBeNull();
  expect(rows[1]!.querySelector("span")).not.toBeNull();
  expect(rows[0]!.getAttribute("data-action")).toBe("More");
});

it("opens a chat on its own route, and its sheet on a long press or the row's action", async () => {
  api.chats = [chat("a")];
  await render();
  const row = container.querySelector("[data-row]")!;
  act(() => (row as HTMLElement).click());
  expect(api.push).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { botId: "bot-1", chatId: "a", name: "Ada" },
  });
  act(() => void row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  expect(api.open).toHaveBeenLastCalledWith(api.chats[0], false, false);
  act(() => void row.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true })));
  expect(api.open).toHaveBeenCalledTimes(2);
});

it("offers Pinned in a chat's sheet only while that chat has pinned messages", async () => {
  api.chats = [chat("a"), chat("b")];
  api.pins = { a: [{ messageId: "m-1" }], b: [] };
  await render();
  const [first, second] = [...container.querySelectorAll("[data-row]")];
  act(() => void first!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  expect(api.open).toHaveBeenLastCalledWith(api.chats[0], false, true);
  act(() => void second!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  expect(api.open).toHaveBeenLastCalledWith(api.chats[1], false, false);
});

it("shows when a snoozed chat wakes, and keeps the clock only while one is asleep", async () => {
  api.chats = [chat("a", { snoozedUntil: "2026-11-22T15:00:00.000Z" }), chat("b")];
  await render();
  const [asleep, awake] = [...container.querySelectorAll("[data-row]")];
  expect(asleep!.getAttribute("data-dimmed")).toBe("");
  expect(asleep!.querySelector("small")?.textContent).toBe("wakes 2026-11-22T15:00:00.000Z");
  expect(awake!.getAttribute("data-dimmed")).toBeNull();
  expect(api.tick).toBe(60_000);
  act(() =>
    (asleep as HTMLElement).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
  );
  expect(api.open).toHaveBeenLastCalledWith(api.chats[0], true, false);
  // A wake time already past is not asleep.
  api.chats = [chat("a", { snoozedUntil: "2026-11-22T09:00:00.000Z" })];
  await render();
  expect(container.querySelector("[data-row]")!.getAttribute("data-dimmed")).toBeNull();
  expect(api.tick).toBeNull();
});
