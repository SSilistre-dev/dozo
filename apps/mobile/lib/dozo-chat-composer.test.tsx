// @vitest-environment jsdom

import type { ComponentProps, ReactNode, Ref } from "react";
import { act, Children, createElement, createRef, isValidElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadComposerHandle } from "../components/composer/thread-composer";
import { ThreadComposer } from "../components/composer/thread-composer";

const dimensions = vi.hoisted(() => ({ fontScale: 1 }));

const input = vi.hoisted(() => ({
  clear: vi.fn(),
  change: (_value: string) => {},
  key: (_event: { nativeEvent: { key: string } }) => {},
  select: (_event: { nativeEvent: { selection: { start: number; end: number } } }) => {},
}));
const mentionApi = vi.hoisted(() => ({ rpc: vi.fn(), capture: vi.fn(), generation: 1 }));
vi.mock("./api/api-server", () => ({}));
vi.mock("./auth/api-auth", () => ({}));
vi.mock("./api/api-live", () => ({}));
vi.mock("./api/api", () => ({
  rpc: mentionApi.rpc,
  captureApiRequestContext: mentionApi.capture,
  currentApiBase: () => "https://api.test",
  selectedSpaceId: () => "space-a",
}));
const files = vi.hoisted(() => new Map<string, string>());
const disk = vi.hoisted(() => ({ writes: 0, full: false, moveFails: false }));
const appState = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
vi.mock("expo-file-system", () => {
  const path = (parts: unknown[]) => parts.map(String).join("/");
  class Directory {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = path(parts);
    }
    create() {}
    toString() {
      return this.uri;
    }
  }
  class File {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = path(parts);
    }
    get exists() {
      return files.has(this.uri);
    }
    create() {
      files.set(this.uri, "");
    }
    writeSync(text: string) {
      disk.writes += 1;
      // A full disk leaves the file empty, as a failed native write would.
      if (disk.full) throw new Error("No space left on device");
      files.set(this.uri, text);
    }
    moveSync(destination: File) {
      // Native replacement removes the destination first; a crash can stop it right there.
      if (disk.moveFails) {
        files.delete(destination.uri);
        throw new Error("Move interrupted");
      }
      files.set(destination.uri, files.get(this.uri) ?? "");
      files.delete(this.uri);
    }
    textSync() {
      return files.get(this.uri) ?? "";
    }
    delete() {
      files.delete(this.uri);
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});
vi.mock("./api/session", () => ({
  currentSessionGeneration: () => mentionApi.generation,
  subscribeSessionGeneration: () => () => {},
}));
function nativeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (!isValidElement(node)) return "";
  return Children.toArray((node.props as { children?: ReactNode }).children)
    .map(nativeText)
    .join("");
}
vi.mock("react-native", () => {
  const Surface = ({
    children,
    testID,
    style,
  }: {
    children?: ReactNode;
    testID?: string;
    style?: object;
  }) =>
    createElement("div", { "data-testid": testID, "data-style": JSON.stringify(style) }, children);
  return {
    AppState: {
      addEventListener: (_type: string, listener: (state: string) => void) => {
        appState.listeners.add(listener);
        return { remove: () => appState.listeners.delete(listener) };
      },
    },
    useWindowDimensions: () => dimensions,
    View: Surface,
    ScrollView: Surface,
    Text: Surface,
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessible,
      disabled,
      style,
    }: {
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
      accessible?: boolean;
      disabled?: boolean;
      style?: object;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          "aria-label": accessibilityLabel,
          "data-accessible": accessible,
          disabled,
          "data-style": JSON.stringify(style),
        },
        children,
      ),
    TextInput: ({
      ref,
      children,
      onChangeText,
      onKeyPress,
      onSelectionChange,
      selection,
      style,
      scrollEnabled,
    }: {
      ref?: Ref<HTMLInputElement>;
      children?: ReactNode;
      onChangeText: typeof input.change;
      onKeyPress: typeof input.key;
      onSelectionChange?: typeof input.select;
      selection?: { start: number; end: number };
      style: object;
      scrollEnabled?: boolean;
    }) => {
      input.change = onChangeText;
      input.key = onKeyPress;
      input.select = onSelectionChange ?? (() => {});
      const segments = Children.toArray(children).filter(isValidElement);
      return createElement("input", {
        // The native input's own clear(), which empties the field it shows.
        ref: (element: HTMLInputElement | null) => {
          if (element) Object.assign(element, { clear: input.clear });
          if (typeof ref === "function") ref(element);
          else if (ref) ref.current = element;
        },
        value: segments.map(nativeText).join(""),
        "data-mentions": JSON.stringify(
          segments.filter((segment) => (segment.props as { style?: object }).style).map(nativeText),
        ),
        "data-mention-colors": JSON.stringify(
          segments.map((segment) => (segment.props as { style?: { color?: string } }).style?.color),
        ),
        "data-mention-backgrounds": JSON.stringify(
          segments.map(
            (segment) =>
              (segment.props as { style?: { backgroundColor?: string } }).style?.backgroundColor,
          ),
        ),
        "data-mention-weights": JSON.stringify(
          segments.map(
            (segment) => (segment.props as { style?: { fontWeight?: string } }).style?.fontWeight,
          ),
        ),
        readOnly: true,
        "data-style": JSON.stringify(style),
        "data-scroll-enabled": scrollEnabled,
        "data-selection": JSON.stringify(selection),
      });
    },
  };
});
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("../components/native/glass-surface", () => ({
  GlassSurface: ({
    children,
    shape = "capsule",
    style,
  }: {
    children?: ReactNode;
    shape?: string;
    style?: object;
  }) =>
    createElement("div", { "data-glass": shape, "data-style": JSON.stringify(style) }, children),
}));
vi.mock("../components/native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/bots/bot-avatar", () => ({
  BotAvatar: ({ identity, size }: { identity?: string; size?: number }) =>
    createElement("span", { "data-avatar": identity, "data-size": size }),
}));
vi.mock("./native/native", () => ({
  useMobileTokens: () => ({ link: "token-link" }),
  useResolvedAppearance: () => "light",
}));
const dictation = vi.hoisted(() => ({
  status: "idle",
  toggle: vi.fn(),
  cancel: vi.fn(),
  onWords: (_text: string, _final?: boolean) => {},
}));
vi.mock("./composer/composer-dictation", () => ({
  useComposerDictation: (opts: { onWords: (text: string, final?: boolean) => void }) => {
    dictation.onWords = opts.onWords;
    return dictation;
  },
}));

const props: Omit<ComponentProps<typeof ThreadComposer>, "ref"> = {
  agentSkills: [],
  composerMentionTargets: [],
  composerPrompt: "Message…",
  replyQuote: null,
  attachmentIds: [],
  botId: "bot-1",
  onCall: false,
  sending: false,
  styles: { composerFill: {} },
  attachActions: [{ id: "library", title: "Photo library" }],
  attachFrom: vi.fn(),
  send: vi.fn(async () => {}),
  startVoiceCall: vi.fn(async () => {}),
  onSlashAction: vi.fn(),
};

let root: Root;
let container: HTMLDivElement;
const composer = createRef<ThreadComposerHandle>();
const render = (changes: Partial<typeof props> = {}) =>
  act(() => root.render(<ThreadComposer ref={composer} {...props} {...changes} />));
const attachButton = () => container.querySelector('[data-glass="circle"]');
const call = () => container.querySelector('button[aria-label="Call"]');

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  files.clear();
  appState.listeners.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// A bot's main chat looks as it did: the attach button and, with nothing typed, the call button.
it("keeps the attach and call buttons in a bot's main chat", () => {
  render();
  expect(attachButton()).not.toBeNull();
  expect(call()).not.toBeNull();
});

// The server refuses a file in an extra chat and a call outside the main chat, so the composer of
// an extra chat does not offer them.
it("offers no attach button without attach actions, and no call without a bot", () => {
  render({ attachActions: [], botId: undefined });
  expect(attachButton()).toBeNull();
  expect(call()).toBeNull();
  expect(container.querySelector('button[aria-label="Send"]')).not.toBeNull();
});
