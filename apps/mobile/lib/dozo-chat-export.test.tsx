// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree: the export procedure exists once the brand rules apply.

const api = vi.hoisted(() => ({
  rpc: vi.fn(),
  share: vi.fn(),
  alert: vi.fn(),
  sheet: vi.fn(),
  push: vi.fn(),
  newChat: vi.fn(),
  upstream: vi.fn(),
  trust: [] as { id: string; text: string; onPress: () => void }[],
  pins: { threadId: undefined as string | undefined, pins: undefined as unknown[] | undefined },
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("react-native", () => ({ Alert: { alert: api.alert }, Share: { share: api.share } }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: api.push }) }));
vi.mock("./api/api", () => ({ rpc: api.rpc }));
vi.mock("./appearance/appearance", () => ({ resolveMobileAppearance: () => "dark" }));
vi.mock("./messages/message-action-sheet", () => ({ presentMessageActionSheet: api.sheet }));
vi.mock("./dozo-message-actions", () => ({ useDozoChatPins: () => api.pins }));
vi.mock("./dozo-trust-bot", () => ({ useDozoTrustActions: () => api.trust }));
vi.mock("./dozo-bot-chats", () => ({ useDozoNewChat: () => ({ run: api.newChat }) }));
vi.mock("./api/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../components/bots/bot-profile-menu", () => ({
  useBotProfileActions: api.upstream,
  botProfileMenuOptions: () => ({}),
}));
vi.mock("../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));

import { botProfileMenuOptions, useBotProfileActions } from "../components/dozo-bot-profile-menu";
import { DozoGroupChatActions } from "../components/dozo-group-chat-actions";
import { useChatExport } from "./dozo-chat-export";

const clear = { id: "clear", text: "Clear conversation", destructive: true, onPress: vi.fn() };
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The range sheet's last choices, by label. */
function chooseRange(label: string) {
  const { actions } = api.sheet.mock.lastCall![0] as {
    actions: { text: string; onPress: () => void }[];
  };
  actions.find((action) => action.text === label)!.onPress();
}

let root: Root;
let container: HTMLDivElement;
async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

let exportChat: ReturnType<typeof useChatExport>;
function Exporter() {
  exportChat = useChatExport();
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useRealTimers();
  for (const mock of [
    api.rpc,
    api.share,
    api.alert,
    api.sheet,
    api.push,
    api.newChat,
    api.upstream,
  ])
    mock.mockReset();
  api.upstream.mockReturnValue([clear]);
  api.share.mockResolvedValue({ action: "sharedAction" });
  api.pins = { threadId: undefined, pins: undefined };
  api.trust = [];
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("export on mobile", () => {
  it("asks how far back, as the web menu does", async () => {
    await render(<Exporter />);
    exportChat({ botId: "bot-1" }, "Ada");
    expect(api.sheet).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Export", cancel: "Cancel", colorScheme: "dark" }),
    );
    const { actions } = api.sheet.mock.lastCall![0] as { actions: { text: string }[] };
    expect(actions.map((action) => action.text)).toEqual([
      "Whole chat",
      "Today",
      "Last 7 days",
      "Last 30 days",
    ]);
  });

  it("hands the whole chat, as the server renders it, to the share sheet", async () => {
    await render(<Exporter />);
    api.rpc.mockResolvedValueOnce({ markdown: "# Ada\n", truncated: false });
    exportChat({ botId: "bot-1" }, "Ada");
    chooseRange("Whole chat");
    await vi.waitFor(() =>
      expect(api.share).toHaveBeenCalledWith({ message: "# Ada\n", title: "Ada" }),
    );
    expect(api.rpc).toHaveBeenCalledWith("dozoChatExport/markdown", {
      botId: "bot-1",
      since: undefined,
      timeZone,
    });
    expect(api.alert).not.toHaveBeenCalled();
  });

  it("exports an extra chat as chatBotId and chatId, never as its bot's main chat", async () => {
    await render(<Exporter />);
    api.rpc.mockResolvedValueOnce({ markdown: "# Launch\n", truncated: false });
    exportChat({ chatBotId: "bot-1", chatId: "chat-1" }, "Launch");
    chooseRange("Whole chat");
    await vi.waitFor(() =>
      expect(api.share).toHaveBeenCalledWith({ message: "# Launch\n", title: "Launch" }),
    );
    const body = api.rpc.mock.lastCall![1] as Record<string, unknown>;
    expect(body).toMatchObject({ chatBotId: "bot-1", chatId: "chat-1" });
    expect(body).not.toHaveProperty("botId");
  });

  it("exports a group from the reader's midnight and says when early messages were left out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 20, 15, 30));
    await render(<Exporter />);
    api.rpc.mockResolvedValueOnce({ markdown: "# Team\n", truncated: true });
    exportChat({ groupId: "group-1" }, "Team");
    chooseRange("Today");
    await vi.waitFor(() =>
      expect(api.alert).toHaveBeenCalledWith("Earlier messages were left out"),
    );
    expect(api.rpc).toHaveBeenCalledWith("dozoChatExport/markdown", {
      groupId: "group-1",
      since: new Date(2026, 10, 20).toISOString(),
      timeZone,
    });
  });

  it("says why when the export fails", async () => {
    await render(<Exporter />);
    api.rpc.mockRejectedValueOnce(new Error("Not found"));
    exportChat({ botId: "bot-1" }, "Ada");
    chooseRange("Last 30 days");
    await vi.waitFor(() => expect(api.alert).toHaveBeenCalledWith("Could not export", "Not found"));
    expect(api.share).not.toHaveBeenCalled();
  });
});

describe("the bot profile's menu", () => {
  let actions: ReturnType<typeof useBotProfileActions> = [];
  function Profile() {
    actions = useBotProfileActions("bot-1", "Ada");
    return null;
  }

  it("puts New chat and Export before upstream's actions and keeps the header menu as it is", async () => {
    await render(<Profile />);
    expect(api.upstream).toHaveBeenCalledWith("bot-1", "Ada");
    expect(actions.map((action) => action.text)).toEqual([
      "New chat",
      "Export",
      "Clear conversation",
    ]);
    actions[1]!.onPress();
    expect(api.sheet).toHaveBeenCalledOnce();
    expect(api.newChat).not.toHaveBeenCalled();
    expect(botProfileMenuOptions).toBeTypeOf("function");
  });

  it("makes a chat of the bot from New chat", async () => {
    await render(<Profile />);
    actions[0]!.onPress();
    expect(api.newChat).toHaveBeenCalledOnce();
  });

  it("offers Pinned only while the chat has pins, and opens the list", async () => {
    api.pins = { threadId: "thread-1", pins: [] };
    await render(<Profile />);
    expect(actions.map((action) => action.id)).toEqual(["newChat", "export", "clear"]);
    api.pins = { threadId: "thread-1", pins: [{ messageId: "m-1" }] };
    await render(<Profile />);
    expect(actions.map((action) => action.text)).toEqual([
      "New chat",
      "Export",
      "Pinned",
      "Clear conversation",
    ]);
    actions[2]!.onPress();
    expect(api.push).toHaveBeenCalledWith({
      pathname: "/dozo-pins",
      params: { threadId: "thread-1", botId: "bot-1", name: "Ada" },
    });
  });
});

describe("the bot profile's menu for a marked bot", () => {
  it("puts Trust this bot again after Export and before upstream's actions", async () => {
    api.trust = [{ id: "trust", text: "Trust this bot again", onPress: vi.fn() }];
    let actions: ReturnType<typeof useBotProfileActions> = [];
    function Profile() {
      actions = useBotProfileActions("bot-1", "Ada");
      return null;
    }
    await render(<Profile />);
    expect(actions.map((action) => action.text)).toEqual([
      "New chat",
      "Export",
      "Trust this bot again",
      "Clear conversation",
    ]);
  });
});

describe("group settings", () => {
  const buttons = () => [...container.querySelectorAll("button")];

  it("offer Export, and Pinned only while the group's chat has pins", async () => {
    await render(<DozoGroupChatActions groupId="group-1" name="Team" />);
    expect(buttons().map((button) => button.textContent)).toEqual(["Export"]);
    act(() => buttons()[0]!.click());
    expect(api.sheet).toHaveBeenCalledOnce();

    api.pins = { threadId: "thread-g", pins: [{ messageId: "m-1" }] };
    await render(<DozoGroupChatActions groupId="group-1" name="Team" />);
    expect(buttons().map((button) => button.textContent)).toEqual(["Export", "Pinned"]);
    act(() => buttons()[1]!.click());
    expect(api.push).toHaveBeenCalledWith({
      pathname: "/dozo-pins",
      params: { threadId: "thread-g", groupId: "group-1", name: "Team" },
    });
    await act(() => flush());
  });
});
