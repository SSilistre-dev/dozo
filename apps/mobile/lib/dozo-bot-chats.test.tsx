// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  rpc: vi.fn(),
  push: vi.fn(),
  alert: vi.fn(),
  sheet: vi.fn(),
  exportChat: vi.fn(),
  ask: vi.fn(),
  signal: { current: (() => {}) as () => unknown },
  signalEnabled: { current: false },
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: {
      date: (value: Date, format: object) =>
        `date:${value.toISOString()}:${JSON.stringify(format)}`,
      _: (label: unknown) => String(label),
    },
  }),
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: api.push }) }));
vi.mock("react-native", () => ({ Alert: { alert: api.alert } }));
vi.mock("../components/profile-edit-dialog", () => ({
  useTextEditDialog: (label: string, max: number) => ({
    ask: (value: string, commit: (next: string) => void) => api.ask(label, max, value, commit),
    dialog: createElement("i", { "data-dialog": label }),
  }),
}));
vi.mock("./appearance", () => ({ resolveMobileAppearance: () => "dark" }));
vi.mock("./dozo-chat-export", () => ({ useChatExport: () => api.exportChat }));
vi.mock("./inbox-swipe", () => ({
  SNOOZE_LABELS: {
    hour: "1 hour",
    threeHours: "3 hours",
    tomorrow: "Tomorrow",
    nextWeek: "Next week",
  },
}));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: api.sheet }));
vi.mock("./roster-signals", () => ({
  useRosterSignals: (read: () => unknown, enabled: boolean) => {
    api.signal.current = read;
    api.signalEnabled.current = enabled;
  },
}));
vi.mock("./user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("./query", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const { useRef } = await import("react");
  return {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    rpcQuery: (proc: string, input: unknown) => ({
      queryKey: [proc, input],
      queryFn: () => api.rpc(proc, input),
    }),
    // The save's own machinery is the app's; this one sends, then reports as it does.
    useSave: <I, S>(options: {
      save: (input: I, send: (proc: string, body: unknown) => Promise<unknown>) => Promise<S>;
      onSaved?: (saved: S, input: I) => unknown;
      onFailed?: (error: Error, input: I) => unknown;
    }) => {
      const latest = useRef(options);
      latest.current = options;
      return {
        run: (input: I) =>
          void latest.current
            .save(input, (proc, body) => api.rpc(proc, body) as Promise<never>)
            .then(
              (saved) => latest.current.onSaved?.(saved, input),
              (error: Error) => latest.current.onFailed?.(error, input),
            ),
      };
    },
  };
});

import type { DozoBotChat } from "@rakazo/contracts";
import {
  dozoTitleName,
  newChatName,
  useDozoBotChats,
  useDozoChatMenu,
  useDozoChatName,
  useDozoNewChat,
} from "./dozo-bot-chats";
import { queryClient } from "./query";

const chat = (overrides: Partial<DozoBotChat> = {}): DozoBotChat => ({
  id: "chat-1",
  botId: "bot-1",
  name: "Nov 21, 5:41 PM",
  createdAt: "2026-11-21T17:41:00.000Z",
  archivedAt: null,
  unread: false,
  snoozedUntil: null,
  ...overrides,
});

let root: Root;
const render = (node: ReactNode) => act(async () => root.render(node));
const settle = () => act(async () => {});
const sheetActions = () =>
  (api.sheet.mock.lastCall![0] as { actions: { text: string; onPress: () => void }[] }).actions;
const press = (text: string) =>
  sheetActions()
    .find((action) => action.text === text)!
    .onPress();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [api.rpc, api.push, api.alert, api.sheet, api.exportChat, api.ask])
    mock.mockReset();
  api.rpc.mockResolvedValue({ chats: [chat()] });
  queryClient.clear();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("a bot's chat list", () => {
  let seen: DozoBotChat[] | undefined;
  function List({ botId }: { botId: string }) {
    seen = useDozoBotChats(botId);
    return null;
  }

  it("reads the bot's open chats once, and again on the roster signal", async () => {
    await render(createElement(List, { botId: "bot-1" }));
    await vi.waitFor(() => expect(seen).toEqual([chat()]));
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith("dozoChats/list", { botId: "bot-1" });
    expect(api.signalEnabled.current).toBe(true);
    api.rpc.mockResolvedValue({ chats: [chat(), chat({ id: "chat-2", name: "Later" })] });
    await act(async () => void (await api.signal.current()));
    await vi.waitFor(() => expect(seen?.map((entry) => entry.id)).toEqual(["chat-1", "chat-2"]));
  });

  it("reads nothing without a bot", async () => {
    await render(createElement(List, { botId: "" }));
    await settle();
    expect(seen).toBeUndefined();
    expect(api.rpc).not.toHaveBeenCalled();
    expect(api.signalEnabled.current).toBe(false);
  });
});

describe("an extra chat's title", () => {
  let name: string | undefined;
  function Title({ chatId }: { chatId?: string }) {
    name = useDozoChatName("bot-1", chatId);
    return null;
  }

  it("says the bot's name, then the chat's", () => {
    expect(dozoTitleName("Ada", "Launch plan")).toBe("Ada · Launch plan");
    expect(dozoTitleName("Ada", undefined)).toBe("Ada");
    expect(dozoTitleName(undefined, "Launch plan")).toBeUndefined();
  });

  it("reads the open extra chat's name from the bot's list", async () => {
    api.rpc.mockResolvedValue({ chats: [chat(), chat({ id: "chat-2", name: "Launch plan" })] });
    await render(createElement(Title, { chatId: "chat-2" }));
    await vi.waitFor(() => expect(name).toBe("Launch plan"));
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith("dozoChats/list", { botId: "bot-1" });
  });

  it("asks for nothing on a main chat", async () => {
    await render(createElement(Title, {}));
    await settle();
    expect(name).toBeUndefined();
    expect(api.rpc).not.toHaveBeenCalled();
  });
});

describe("New chat", () => {
  let newChat: ReturnType<typeof useDozoNewChat>;
  function Maker() {
    newChat = useDozoNewChat("bot-1", "Ada");
    return null;
  }

  it("names a chat by when it began", () => {
    const at = new Date("2026-11-21T17:41:00.000Z");
    const i18n = { date: vi.fn(() => "Nov 21, 5:41 PM") };
    expect(newChatName(i18n, at)).toBe("Nov 21, 5:41 PM");
    expect(i18n.date).toHaveBeenCalledWith(at, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  });

  it("makes the bot's chat and opens it on its own route", async () => {
    api.rpc.mockResolvedValue({ chat: chat() });
    await render(createElement(Maker));
    act(() => newChat.run(undefined));
    await settle();
    expect(api.rpc).toHaveBeenCalledWith("dozoChats/create", {
      botId: "bot-1",
      name: expect.stringContaining("date:"),
    });
    expect(api.push).toHaveBeenCalledWith({
      pathname: "/thread",
      params: { botId: "bot-1", chatId: "chat-1", name: "Ada" },
    });
  });

  it("says why it could not, and opens nothing", async () => {
    api.rpc.mockRejectedValue(new Error("This bot holds the most chats it can."));
    await render(createElement(Maker));
    act(() => newChat.run(undefined));
    await settle();
    expect(api.alert).toHaveBeenCalledWith(
      "Could not update chat",
      "This bot holds the most chats it can.",
    );
    expect(api.push).not.toHaveBeenCalled();
  });
});

describe("a chat's sheet", () => {
  let menu: ReturnType<typeof useDozoChatMenu>;
  function Menu() {
    menu = useDozoChatMenu("bot-1");
    return null;
  }
  const open = async (entry: DozoBotChat, snoozed = false, pinned = false) => {
    await render(createElement(Menu));
    act(() => menu.open(entry, snoozed, pinned));
  };

  it("offers the web menu's actions, titled by the chat", async () => {
    await open(chat());
    expect(api.sheet).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Nov 21, 5:41 PM",
        cancel: "Cancel",
        more: "More",
        colorScheme: "dark",
      }),
    );
    expect(sheetActions().map((action) => action.text)).toEqual([
      "Rename",
      "Mark as Unread",
      "Snooze",
      "Export",
      "Archive",
    ]);
  });

  it("marks a chat read or unread as that chat, never as the bot's main chat", async () => {
    await open(chat({ unread: true }));
    expect(sheetActions()[1]!.text).toBe("Mark as Read");
    press("Mark as Read");
    await settle();
    expect(api.rpc).toHaveBeenLastCalledWith("threads/markRead", {
      chatBotId: "bot-1",
      chatId: "chat-1",
    });
    await open(chat());
    press("Mark as Unread");
    await settle();
    expect(api.rpc).toHaveBeenLastCalledWith("threads/markUnread", {
      chatBotId: "bot-1",
      chatId: "chat-1",
    });
  });

  it("snoozes to a preset, and brings a snoozed chat back", async () => {
    await open(chat());
    press("Snooze");
    expect(api.sheet).toHaveBeenCalledTimes(2);
    expect(sheetActions().map((action) => action.text)).toEqual([
      "1 hour",
      "3 hours",
      "Tomorrow",
      "Next week",
    ]);
    sheetActions()[0]!.onPress();
    await settle();
    expect(api.rpc).toHaveBeenLastCalledWith("threads/snooze", {
      chatBotId: "bot-1",
      chatId: "chat-1",
      until: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    await open(chat({ snoozedUntil: "2099-01-01T09:00:00.000Z" }), true);
    expect(sheetActions()[2]!.text).toBe("Unsnooze");
    press("Unsnooze");
    await settle();
    expect(api.rpc).toHaveBeenLastCalledWith("threads/snooze", {
      chatBotId: "bot-1",
      chatId: "chat-1",
      until: null,
    });
  });

  it("renames through the system prompt, ignoring an empty or unchanged name", async () => {
    await open(chat());
    press("Rename");
    expect(api.ask).toHaveBeenCalledWith("Rename", 80, "Nov 21, 5:41 PM", expect.any(Function));
    const commit = api.ask.mock.lastCall![3] as (name: string) => void;
    commit("");
    commit("Nov 21, 5:41 PM");
    await settle();
    expect(api.rpc).not.toHaveBeenCalled();
    commit("Launch plan");
    await settle();
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith("dozoChats/rename", {
      chatId: "chat-1",
      name: "Launch plan",
    });
  });

  it("lists the chat's pins from the sheet, as that chat's", async () => {
    await open(chat(), false, true);
    expect(sheetActions().map((action) => action.text)).toContain("Pinned");
    press("Pinned");
    expect(api.push).toHaveBeenCalledWith({
      pathname: "/dozo-pins",
      params: { threadId: "chat-1", botId: "bot-1", chatId: "chat-1", name: "Nov 21, 5:41 PM" },
    });
  });

  it("exports the chat itself, as chatBotId and chatId", async () => {
    await open(chat());
    press("Export");
    expect(api.exportChat).toHaveBeenCalledWith(
      { chatBotId: "bot-1", chatId: "chat-1" },
      "Nov 21, 5:41 PM",
    );
  });

  it("archives the chat, and says why when it cannot", async () => {
    await open(chat());
    press("Archive");
    await settle();
    expect(api.rpc).toHaveBeenLastCalledWith("dozoChats/archive", {
      chatId: "chat-1",
      archived: true,
    });
    api.rpc.mockRejectedValue(new Error("offline"));
    press("Archive");
    await settle();
    expect(api.alert).toHaveBeenCalledWith("Could not update chat", "offline");
  });

  it("carries the rename prompt with it", async () => {
    await render(createElement(Menu));
    expect(menu.dialog).toBeTruthy();
  });
});
