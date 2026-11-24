// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  chats: undefined as unknown[] | undefined,
  enabled: undefined as boolean | undefined,
  now: Date.parse("2026-11-22T12:00:00.000Z"),
  clockSaw: undefined as unknown,
}));

vi.mock("./dozo-bot-chats", () => ({
  useDozoSpaceChats: (enabled: boolean) => {
    api.enabled = enabled;
    return api.chats;
  },
}));
vi.mock("./use-snooze-clock", () => ({
  useSnoozeClock: (chats: unknown) => {
    api.clockSaw = chats;
    return api.now;
  },
}));
vi.mock("./inbox-spaces", () => ({
  inboxItemKey: (item: { type: string; bot?: { id: string } }) => `upstream-${item.bot?.id}`,
  inboxSignal: () => ({ unread: 5, attention: 6 }),
}));

import type { DozoBotChat } from "@rakazo/contracts";
import type { DozoInboxItem } from "./dozo-inbox-chats";
import {
  dozoInboxItemKey,
  dozoInboxItems,
  dozoInboxSignal,
  useDozoInboxItems,
} from "./dozo-inbox-chats";
import type { InboxItem } from "./inbox-spaces";
import type { MobileBot } from "./mobile-types";

const bot = (id: string) => ({ id, name: `Bot ${id}` }) as MobileBot;
const botItem = (id: string): InboxItem => ({ type: "bot", bot: bot(id) });
const heading: InboxItem = { type: "heading", key: "h", title: "Work" };
const chat = (id: string, botId: string, overrides: Partial<DozoBotChat> = {}): DozoBotChat => ({
  id,
  botId,
  name: `Chat ${id}`,
  createdAt: "2026-11-21T17:41:00.000Z",
  archivedAt: null,
  unread: false,
  snoozedUntil: null,
  ...overrides,
});
const keys = (items: DozoInboxItem[]) =>
  items.map((item) =>
    item.type === "botChat" ? `${item.bot.id}/${item.chat.id}` : (item.type + (item.type === "bot" ? item.bot.id : "")),
  );

it("lists a bot's open extra chats under the bot, in the order the server gave them", () => {
  const items = [heading, botItem("a"), botItem("b")];
  const rows = dozoInboxItems(
    items,
    [chat("b2", "b"), chat("a1", "a"), chat("b1", "b")],
    api.now,
  );
  expect(keys(rows)).toEqual(["heading", "bota", "a/a1", "botb", "b/b2", "b/b1"]);
  const first = rows[2];
  expect(first).toMatchObject({ type: "botChat", bot: bot("a"), chat: chat("a1", "a") });
});

it("leaves archived and snoozed chats out until they wake, and keeps awake and woken ones", () => {
  const rows = dozoInboxItems(
    [botItem("a")],
    [
      chat("archived", "a", { archivedAt: "2026-11-20T00:00:00.000Z" }),
      chat("asleep", "a", { snoozedUntil: "2026-11-22T15:00:00.000Z" }),
      chat("woke", "a", { snoozedUntil: "2026-11-22T09:00:00.000Z" }),
      chat("plain", "a"),
    ],
    api.now,
  );
  expect(keys(rows)).toEqual(["bota", "a/woke", "a/plain"]);
});

it("is the very list it was given when no chat belongs to a listed bot, or none is read yet", () => {
  const items = [heading, botItem("a")];
  expect(dozoInboxItems(items, undefined, api.now)).toBe(items);
  expect(dozoInboxItems(items, [], api.now)).toBe(items);
  // Another Space's bot, a bot not in this list, and a chat that is out of the list.
  expect(dozoInboxItems(items, [chat("x1", "elsewhere")], api.now)).toEqual(items);
  expect(
    dozoInboxItems(items, [chat("gone", "a", { archivedAt: "2026-11-20T00:00:00.000Z" })], api.now),
  ).toBe(items);
});

it("counts a chat's own unread for the pills, and its key is its own id", () => {
  const row = (unread: boolean): DozoInboxItem => ({
    type: "botChat",
    bot: bot("a"),
    chat: chat("a1", "a", { unread }),
  });
  expect(dozoInboxSignal(row(true))).toEqual({ unread: 1, attention: 0 });
  expect(dozoInboxSignal(row(false))).toEqual({ unread: 0, attention: 0 });
  expect(dozoInboxItemKey(row(false))).toBe("chat-a1");
  // Every other row is as upstream counts and names it.
  expect(dozoInboxSignal(botItem("a"))).toEqual({ unread: 5, attention: 6 });
  expect(dozoInboxItemKey(botItem("a"))).toBe("upstream-a");
});

let root: Root;
let seen: DozoInboxItem[] | undefined;
function Rows({ items, enabled }: { items: InboxItem[]; enabled: boolean }) {
  seen = useDozoInboxItems(items, enabled);
  return null;
}
const render = (items: InboxItem[], enabled = true) =>
  act(async () => root.render(createElement(Rows, { items, enabled })));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.chats = undefined;
  api.enabled = undefined;
  seen = undefined;
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("adds the Space's chats under their bots while it is wanted", async () => {
  const items = [botItem("a")];
  api.chats = [chat("a1", "a")];
  await render(items);
  expect(api.enabled).toBe(true);
  expect(keys(seen!)).toEqual(["bota", "a/a1"]);
  // The clock follows the chats it is handed, so a chat that wakes comes back.
  expect(api.clockSaw).toBe(api.chats);
});

it("shows only the given rows, whatever was read before, while it is not wanted", async () => {
  const items = [botItem("a")];
  api.chats = [chat("a1", "a")];
  await render(items, false);
  expect(api.enabled).toBe(false);
  expect(seen).toBe(items);
});

it("shows the given rows until the first answer", async () => {
  const items = [botItem("a")];
  await render(items);
  expect(seen).toBe(items);
  expect(api.clockSaw).toEqual([]);
});
