// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree: the message procedures exist once the brand rules apply.

const ui = vi.hoisted(() => ({
  rpc: vi.fn(),
  params: {} as Record<string, string | undefined>,
  back: vi.fn(),
  dismissTo: vi.fn(),
  header: undefined as
    | {
        title?: string;
        action?: { label: string; disabled?: boolean; busy?: boolean; onPress: () => void } | null;
      }
    | undefined,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  StyleSheet: { create: <T,>(styles: T) => styles },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <p role="alert">{children}</p>,
  TextInput: ({
    value,
    onChangeText,
    editable,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    editable?: boolean;
  }) => (
    <textarea
      value={value}
      disabled={editable === false}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-secure-store", () => ({ getItemAsync: async () => null, setItemAsync: vi.fn() }));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ui.params,
  useRouter: () => ({ back: ui.back, dismissTo: ui.dismissTo }),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./native", () => ({
  native: { page: "page", groupedPage: "grouped", fill: "fill", label: "label" },
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./screen-header", () => ({
  useScreenHeader: (header: typeof ui.header) => {
    ui.header = header;
  },
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space",
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space" },
  }),
  rpc: ui.rpc,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./roster-signals", () => ({ useRosterSignals: () => undefined }));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <ul>{children}</ul>,
  SettingsRow: ({ title, onPress }: { title: string; onPress: () => void }) => (
    <li>
      <button type="button" onClick={onPress}>
        {title}
      </button>
    </li>
  ),
}));

import { Alert } from "react-native";
import DozoEditMessage from "../app/dozo-edit-message";
import DozoPins from "../app/dozo-pins";
import { setDozoEditOpener, useDozoMessageActions } from "./dozo-message-actions";
import { queryClient } from "./query";

let root: Root;
let container: HTMLDivElement;
async function render(node: ReactNode) {
  await act(async () => root.render(node));
  await act(() => flush());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  ui.rpc.mockReset();
  ui.back.mockReset();
  ui.dismissTo.mockReset();
  ui.header = undefined;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("the edit screen", () => {
  const editor = () => container.querySelector("textarea")!;
  const type = (text: string) =>
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(editor(), text);
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });

  /** Opens the screen the way a message's Edit does, with its text handed over. */
  async function openFromMenu(
    text: string,
    revisable: Record<string, unknown> = { editMessageId: "m-1", regenerateMessageId: null },
  ) {
    ui.rpc.mockImplementation(async (path: string) =>
      path === "dozoMessages/pins" ? { pins: [] } : revisable,
    );
    let actions: ReturnType<typeof useDozoMessageActions> = [];
    function Row() {
      actions = useDozoMessageActions(
        { id: "m-1", threadId: "thread-1", role: "user", blocks: [{ kind: "text", text }] },
        false,
        false,
      );
      return null;
    }
    await render(<Row />);
    await act(() => vi.waitFor(() => expect(actions[0]?.name).toBe("dozoEdit")));
    setDozoEditOpener((threadId, messageId) => {
      ui.params = { threadId, messageId };
    });
    actions[0]!.onPress();
    await render(<DozoEditMessage />);
  }

  it("opens with the message's text and sends the edit, then closes", async () => {
    await openFromMenu("Hello there");
    expect(editor().value).toBe("Hello there");
    expect(ui.header?.title).toBe("Edit");
    expect(ui.header?.action?.label).toBe("Send");
    await type("  Hello again  ");
    ui.rpc.mockResolvedValueOnce({ runId: "run-2" });
    await act(async () => ui.header!.action!.onPress());
    await vi.waitFor(() => expect(ui.back).toHaveBeenCalledOnce());
    expect(ui.rpc).toHaveBeenCalledWith(
      "dozoMessages/edit",
      { threadId: "thread-1", messageId: "m-1", text: "Hello again" },
      expect.anything(),
    );
  });

  it("cannot send empty text and shows why a send failed", async () => {
    await openFromMenu("Hi");
    await type("   ");
    expect(ui.header?.action?.disabled).toBe(true);
    await type("Hi!");
    expect(ui.header?.action?.disabled).toBe(false);
    ui.rpc.mockRejectedValueOnce(new Error("That message can no longer be edited"));
    await act(async () => ui.header!.action!.onPress());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("That message can no longer be edited"),
    );
    expect(ui.back).not.toHaveBeenCalled();
  });

  it("asks before an earlier message's edit removes the later ones, then sends it", async () => {
    const alert = vi.mocked(Alert.alert);
    alert.mockReset();
    await openFromMenu("Plan dinner", {
      editMessageId: "m-9",
      regenerateMessageId: null,
      earlierEditMessageIds: ["m-1"],
      removedCounts: { "m-1": 4 },
    });
    await type("Plan lunch");
    await act(async () => ui.header!.action!.onPress());
    expect(ui.rpc).not.toHaveBeenCalledWith(
      "dozoMessages/edit",
      expect.anything(),
      expect.anything(),
    );
    const [title, , buttons] = alert.mock.calls[0]!;
    expect(title).toBe("Remove 4 messages?");
    expect(buttons?.map((button) => [button.text, button.style])).toEqual([
      ["Cancel", "cancel"],
      ["Remove", "destructive"],
    ]);
    ui.rpc.mockResolvedValueOnce({ runId: "run-2" });
    await act(async () => buttons![1]!.onPress!());
    await vi.waitFor(() => expect(ui.back).toHaveBeenCalledOnce());
    expect(ui.rpc).toHaveBeenCalledWith(
      "dozoMessages/edit",
      { threadId: "thread-1", messageId: "m-1", text: "Plan lunch" },
      expect.anything(),
    );
  });

  it("opens empty without ids rather than failing", async () => {
    ui.params = {};
    await render(<DozoEditMessage />);
    expect(editor().value).toBe("");
    expect(ui.header?.action?.disabled).toBe(true);
  });
});

describe("the pinned list", () => {
  const pins = [
    { messageId: "m-2", preview: { text: "Newest" } },
    { messageId: "m-1", preview: { text: "", attachment: { name: "plan.pdf" } } },
  ];

  it("lists a bot chat's pins, newest first, and goes back to the chat at the one chosen", async () => {
    ui.params = { threadId: "thread-1", botId: "bot-1", name: "Ada" };
    ui.rpc.mockResolvedValue({ pins });
    await render(<DozoPins />);
    await act(() => vi.waitFor(() => expect(container.querySelectorAll("button").length).toBe(2)));
    expect([...container.querySelectorAll("button")].map((row) => row.textContent)).toEqual([
      "Newest",
      "plan.pdf",
    ]);
    expect(ui.header?.title).toBe("Pinned");
    act(() => container.querySelectorAll("button")[1]!.click());
    expect(ui.dismissTo).toHaveBeenCalledWith({
      pathname: "/thread",
      params: { botId: "bot-1", name: "Ada", messageId: "m-1" },
    });
  });

  it("goes back to a group's chat", async () => {
    ui.params = { threadId: "thread-g", groupId: "group-1" };
    ui.rpc.mockResolvedValue({ pins });
    await render(<DozoPins />);
    await act(() => vi.waitFor(() => expect(container.querySelector("button")).not.toBeNull()));
    act(() => container.querySelector("button")!.click());
    expect(ui.dismissTo).toHaveBeenCalledWith({
      pathname: "/group-thread",
      params: { groupId: "group-1", name: "", messageId: "m-2" },
    });
  });

  it("shows nothing for a missing chat, and never names a chat it was not given", async () => {
    ui.params = { name: "Ada" };
    await render(<DozoPins />);
    await act(() => vi.waitFor(() => expect(ui.header?.title).toBe("Pinned")));
    expect(container.querySelector("button")).toBeNull();
    expect(ui.rpc).not.toHaveBeenCalled();

    ui.params = { threadId: "thread-1" };
    ui.rpc.mockResolvedValue({ pins });
    await render(<DozoPins />);
    await act(() => vi.waitFor(() => expect(container.querySelector("button")).not.toBeNull()));
    act(() => container.querySelector("button")!.click());
    expect(ui.dismissTo).toHaveBeenCalledWith({
      pathname: "/thread",
      params: { botId: "", name: "", messageId: "m-2" },
    });
  });
});
