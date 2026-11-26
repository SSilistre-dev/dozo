// @vitest-environment jsdom

import type { ReactNode, Ref } from "react";
import { act, createContext, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Api from "./api/api";
import type { MobileMessage } from "./api/mobile-types";

vi.mock("react-native", async () => {
  const { createElement, useImperativeHandle } = await import("react");
  const flatten = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flatten))
      : ((style as Record<string, unknown>) ?? {});
  const element =
    (tag: string) =>
    ({
      children,
      style,
      onPress,
      onLongPress,
      numberOfLines,
      accessibilityState,
      accessibilityRole,
      accessibilityLabel,
      ref,
    }: {
      children?: ReactNode;
      style?: unknown;
      onPress?: () => void;
      onLongPress?: () => void;
      numberOfLines?: number;
      accessibilityState?: { expanded?: boolean };
      accessibilityRole?: string;
      accessibilityLabel?: string;
      ref?: Ref<unknown>;
    }) => {
      useImperativeHandle(ref, () => ({
        measureInWindow: (done: (...values: number[]) => void) => done(0, 100, 300, 200),
      }));
      return createElement(
        tag,
        {
          "data-style": JSON.stringify(flatten(style)),
          "data-number-of-lines": numberOfLines,
          "aria-expanded": accessibilityState?.expanded,
          role: accessibilityRole,
          "aria-label": accessibilityLabel,
          onClick: onPress,
          onContextMenu: onLongPress,
        },
        children,
      );
    };
  return {
    Alert: { alert: vi.fn() },
    Appearance: { getColorScheme: () => "light", addChangeListener: () => ({ remove() {} }) },
    Linking: { openURL: vi.fn().mockResolvedValue(undefined) },
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
    Pressable: element("button"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: element("span"),
    TextInput: element("input"),
    View: element("div"),
    useWindowDimensions: () => ({ width: 393, height: 852, scale: 1, fontScale: 1 }),
  };
});

vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  return {
    default: { View },
    useAnimatedStyle: (style: () => unknown) => style(),
    useReducedMotion: () => true,
    useSharedValue: (value: number) => ({ value }),
    withTiming: (value: number) => value,
  };
});

vi.mock("expo-secure-store", () => ({}));
vi.mock("../components/thread/routine-event-row", () => ({ RoutineEventRows: () => null }));
vi.mock("./notifications/live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
vi.mock("./api/network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./artifacts/artifact-open", () => ({ openMobileArtifact: vi.fn() }));

vi.mock("./native/native", () => ({
  native: { fill: "fill", fillPressed: "fill-pressed" },
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));

vi.mock("@rakazo/chat-ui/native", () => ({
  MarkdownLongPressContext: createContext(undefined),
  ChatMarkdown: ({ children }: { children: string }) => <p>{children}</p>,
  withBlockMentions: <T,>(blocks: T) => blocks,
  useNativeLinkConfirm: () => vi.fn(),
}));

vi.mock("../components/messages/message-caption", () => ({
  MessageCaption: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("../components/bots/bot-avatar", () => ({ BotAvatar: () => <i /> }));
vi.mock("../components/native/native-symbol", () => ({
  NativeSymbol: ({ ios }: { ios: string }) => <i data-symbol={ios} />,
}));
vi.mock("../components/native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    selected,
  }: {
    label: string;
    onPress?: () => void;
    disabled?: boolean;
    selected?: boolean;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      aria-pressed={selected || undefined}
    >
      {label}
    </button>
  ),
}));
// Cards this file doesn't exercise; each has its own tests.
vi.mock("../components/thread/ask-block", () => ({ AskBlock: () => null }));
vi.mock("../components/cards/AppConnectCard", () => ({ AppConnectCard: () => null }));
vi.mock("../components/media/audio-attachment", () => ({ AudioAttachment: () => null }));
vi.mock("../components/cards/ChoiceCard", () => ({ ChoiceCard: () => null }));
vi.mock("../components/cards/ImportSetupCard", () => ({ ImportSetupCard: () => null }));
vi.mock("../components/cards/ComputerCard", () => ({ ComputerCard: () => null }));
vi.mock("./pages/page-card", () => ({ PageCard: () => null }));
vi.mock("../components/thread/mcp-app-card", () => ({ McpAppCard: () => null }));
vi.mock("../components/media/inline-image-attachment", () => ({
  InlineImageAttachment: ({ name, onOpen }: { name: string; onOpen: () => void }) => (
    <button type="button" aria-label={name} onClick={onOpen} />
  ),
}));
vi.mock("../components/cards/change-undo", () => ({
  ChangeUndo: () => null,
  isUndoableChange: () => false,
}));

vi.mock("./api/api", async (original) => ({
  ...(await original<typeof Api>()),
  rpc: vi.fn(async () => ({ ok: true })),
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async () => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-1" },
  }),
}));
vi.mock("./api/session", () => ({ currentSessionGeneration: () => 1 }));

import { MessageBubble } from "../components/thread/message-bubble";
import { rpc } from "./api/api";
import { DozoChatContext } from "./dozo-chat-target";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc).mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const runningHelper = {
  id: "card-1",
  role: "bot",
  botId: "bot-1",
  blocks: [
    { kind: "subagent", agentId: "card-1", name: "scout", task: "venues", status: "running" },
  ],
} as MobileMessage;

function show(chat: string | undefined) {
  act(() =>
    root.render(
      createElement(
        DozoChatContext.Provider,
        { value: chat },
        <MessageBubble
          botId="bot-1"
          bots={[]}
          showBotSenderName={false}
          canAnswer={false}
          canDismiss={false}
          onAnswer={async () => undefined}
          onOpenBot={() => undefined}
          onOpenComputer={() => undefined}
          onPreviewFile={() => undefined}
          onPreviewImage={() => undefined}
          onOpenPeerChat={() => undefined}
          message={runningHelper}
          actionProps={{}}
        />,
      ),
    ),
  );
}
const stop = () =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === "Stop");

// The helper's card is in one chat, and Stop names it: a stop that named the bot would look for the
// card in the bot's main chat.
it("stops a helper in an extra chat as that chat's", async () => {
  show("chat-1");
  await act(async () => stop()?.click());
  expect(rpc).toHaveBeenCalledExactlyOnceWith(
    "threads/stopHelper",
    { chatBotId: "bot-1", chatId: "chat-1", messageId: "card-1" },
    expect.anything(),
  );
});

it("stops a helper in a bot's main chat as before", async () => {
  show(undefined);
  await act(async () => stop()?.click());
  expect(rpc).toHaveBeenCalledExactlyOnceWith(
    "threads/stopHelper",
    { botId: "bot-1", messageId: "card-1" },
    expect.anything(),
  );
});
