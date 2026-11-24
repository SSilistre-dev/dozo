// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree: the feedback procedures exist once the brand rules apply.

type Header = { title?: string };

const ui = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  share: vi.fn(),
  back: vi.fn(),
  pick: vi.fn(),
  platform: { OS: "android", Version: 34 as string | number },
  header: undefined as Header | undefined,
  params: {} as { threadId?: string; messageId?: string },
}));

vi.mock("react-native", () => ({
  Alert: { alert: ui.alert },
  Share: { share: ui.share },
  Platform: ui.platform,
  StyleSheet: { create: <T,>(styles: T) => styles },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  TextInput: ({
    accessibilityLabel,
    value,
    onChangeText,
    placeholder,
    maxLength,
  }: {
    accessibilityLabel: string;
    value: string;
    placeholder: string;
    maxLength: number;
    onChangeText: (value: string) => void;
  }) => (
    <textarea
      aria-label={accessibilityLabel}
      placeholder={placeholder}
      maxLength={maxLength}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn(), back: ui.back, canGoBack: () => true }),
  useLocalSearchParams: () => ui.params,
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./native", () => ({
  native: { groupedPage: "grouped", secondaryLabel: "secondary", tertiaryLabel: "tertiary" },
  useResolvedAppearance: () => "dark",
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./screen-header", () => ({
  useScreenHeader: (header: Header) => {
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
  captureApiRequestContext: async (spaceId: string | null = "space") => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
  rpc: ui.rpc,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./pick-attachments", () => ({ pickFromLibrary: ui.pick }));
vi.mock("./routine", () => ({ deviceTimeZone: () => "Europe/Berlin" }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    busy,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
  }) => (
    <button type="button" disabled={disabled || busy} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children, footer }: { children?: ReactNode; footer?: string }) => (
    <ul>
      {children}
      {footer ? <pre data-footer="">{footer}</pre> : null}
    </ul>
  ),
  SettingsRow: ({
    title,
    detail,
    value,
    onPress,
    accessibilityLabel,
  }: {
    title: string;
    detail?: string;
    value?: string;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <li>
      {onPress ? (
        <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
          {title}
          {value ? <small>{value}</small> : null}
        </button>
      ) : (
        title
      )}
      {detail ? <small>{detail}</small> : null}
    </li>
  ),
  SettingsSwitch: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <li>
      <label>
        <input
          type="checkbox"
          checked={value}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
    </li>
  ),
}));

import DozoFeedback from "../app/(settings)/dozo-feedback";
import { mobileDiagnostics, pickFeedbackImages } from "./dozo-feedback";
import { queryClient } from "./query";

let answers: Record<string, unknown>;
let root: Root;
let container: HTMLDivElement;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
  await act(() => flush());
}
const settle = (check: () => void) => act(() => vi.waitFor(check));
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
const calls = (path: string) => ui.rpc.mock.calls.filter(([called]) => called === path);
const note = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
const write = (value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      note(),
      value,
    );
    note().dispatchEvent(new Event("input", { bubbles: true }));
  });

const status = (extra = {}) => ({
  mode: "send",
  address: null,
  from: "ada@example.test",
  server: {
    revision: "abc1234",
    failedRuns: [{ id: "run-1", at: "2026-11-20T10:00:00.000Z" }],
  },
  ...extra,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  queryClient.clear();
  answers = {};
  ui.rpc.mockReset().mockImplementation(async (path: string, input: unknown) => {
    const value = answers[path];
    if (value instanceof Error) throw value;
    return typeof value === "function" ? value(input) : value;
  });
  for (const mock of [ui.alert, ui.share, ui.back, ui.pick]) mock.mockReset();
  ui.share.mockResolvedValue({ action: "sharedAction" });
  ui.platform.OS = "android";
  ui.header = undefined;
  ui.params = {};
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("feedback on mobile", () => {
  it("shows nothing where the server takes no feedback", async () => {
    answers["dozoFeedback/status"] = status({ mode: null });
    await render(<DozoFeedback />);
    await act(() => flush());
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("sends the note alone unless diagnostics are switched on", async () => {
    answers["dozoFeedback/status"] = status();
    answers["dozoFeedback/send"] = { sent: true };
    await render(<DozoFeedback />);
    await settle(() => expect(note()).not.toBeNull());
    expect(ui.header?.title).toBe("Send feedback");
    expect(note().placeholder).toBe("What happened?");
    expect(button("Send")!.disabled).toBe(true);
    // What is added under the note is shown before anything leaves.
    expect(container.querySelector("[data-footer]")!.textContent).toBe(
      "--\nFrom: ada@example.test",
    );

    await write("  It stopped  ");
    await act(async () => button("Send")!.click());
    await settle(() => expect(ui.alert).toHaveBeenCalledWith("Sent"));
    expect(calls("dozoFeedback/send")[0]![1]).toEqual({ message: "  It stopped  " });
    expect(ui.back).toHaveBeenCalledOnce();
  });

  it("opened from a message's Report, names that message first and sends it as written", async () => {
    ui.params = { threadId: "thread-1", messageId: "m-9" };
    answers["dozoFeedback/status"] = status();
    answers["dozoFeedback/send"] = { sent: true };
    await render(<DozoFeedback />);
    await settle(() => expect(note()).not.toBeNull());
    expect(ui.header?.title).toBe("Report");
    expect(note().value).toBe("Reported message m-9 in chat thread-1\n\n");
    expect(button("Send")!.disabled).toBe(false);
    await write("Reported message m-9 in chat thread-1\n\nAbusive reply");
    await act(async () => button("Send")!.click());
    await settle(() => expect(ui.alert).toHaveBeenCalledWith("Sent"));
    expect(calls("dozoFeedback/send")[0]![1]).toEqual({
      message: "Reported message m-9 in chat thread-1\n\nAbusive reply",
    });
  });

  it("adds exactly the diagnostics the preview lists, and no more", async () => {
    answers["dozoFeedback/status"] = status();
    answers["dozoFeedback/send"] = { sent: true };
    await render(<DozoFeedback />);
    await settle(() => expect(note()).not.toBeNull());
    await write("Slow");
    await act(async () => container.querySelector("input")!.click());
    const preview = container.querySelector("[data-footer]")!.textContent!;
    expect(preview).toBe(
      [
        "--",
        "From: ada@example.test",
        "Surface: mobile",
        "Browser: Dozo android 34",
        "Language: en-US",
        "Time zone: Europe/Berlin",
        "Server revision: abc1234",
        "Failed runs: run-1 (2026-11-20T10:00:00.000Z)",
      ].join("\n"),
    );
    await act(async () => button("Send")!.click());
    await settle(() => expect(calls("dozoFeedback/send")).toHaveLength(1));
    expect(calls("dozoFeedback/send")[0]![1]).toEqual({
      message: "Slow",
      diagnostics: {
        client: {
          surface: "mobile",
          userAgent: "Dozo android 34",
          language: "en-US",
          timeZone: "Europe/Berlin",
        },
        runIds: ["run-1"],
      },
    });
  });

  it("says why it could not send and keeps the note", async () => {
    answers["dozoFeedback/status"] = status();
    answers["dozoFeedback/send"] = new Error("Too many reports");
    await render(<DozoFeedback />);
    await settle(() => expect(note()).not.toBeNull());
    await write("Hello");
    await act(async () => button("Send")!.click());
    await settle(() => expect(ui.alert).toHaveBeenCalledWith("Could not send", "Too many reports"));
    expect(note().value).toBe("Hello");
    expect(ui.back).not.toHaveBeenCalled();
  });

  it("without mail, hands the report to the share sheet and names the address", async () => {
    answers["dozoFeedback/status"] = status({ mode: "save", address: "team@example.test" });
    await render(<DozoFeedback />);
    await settle(() => expect(note()).not.toBeNull());
    expect(text()).toContain("team@example.test");
    expect(button("Send")).toBeUndefined();
    expect(button("Save")!.disabled).toBe(true);
    await write("Please look");
    await act(async () => button("Save")!.click());
    expect(ui.share).toHaveBeenCalledWith({
      message: "Please look\n\n--\nFrom: ada@example.test\n",
    });
    expect(calls("dozoFeedback/send")).toHaveLength(0);
  });

  it("lays the form out for iOS, and names no address when the server shares none", async () => {
    ui.platform.OS = "ios";
    answers["dozoFeedback/status"] = status({ mode: "save", address: null });
    await render(<DozoFeedback />);
    await settle(() => expect(note()).not.toBeNull());
    expect(button("Save")).toBeDefined();
    expect(container.querySelectorAll("li").length).toBe(1);
  });

  it("names a chat-app account's missing reply address, as the report will", async () => {
    answers["dozoFeedback/status"] = status({ from: null });
    await render(<DozoFeedback />);
    await settle(() => expect(note()).not.toBeNull());
    expect(container.querySelector("[data-footer]")!.textContent).toBe(
      "--\nFrom: (no reply address)",
    );
  });
});

describe("what the app says about itself", () => {
  it("is the surface, the system, the language and the time zone, cut to the contract's size", () => {
    expect(mobileDiagnostics()).toMatchObject({
      surface: "mobile",
      userAgent: "Dozo android 34",
      timeZone: "Europe/Berlin",
    });
    expect(Object.keys(mobileDiagnostics()).sort()).toEqual([
      "language",
      "surface",
      "timeZone",
      "userAgent",
    ]);
  });

  it("falls back to UTC when the device cannot name its zone", async () => {
    vi.resetModules();
    vi.doMock("./routine", () => ({ deviceTimeZone: () => undefined }));
    const { mobileDiagnostics: again } = await import("./dozo-feedback");
    expect(again().timeZone).toBe("UTC");
    vi.doUnmock("./routine");
  });
});

const attachment = (name: string, mimeType = "image/png") => ({
  id: name,
  name,
  mimeType,
  contentBase64: "AAAA",
});
const picked = (...files: ReturnType<typeof attachment>[]) =>
  ui.pick.mockResolvedValueOnce({ attachments: files, skipped: [] });
const addRow = () => button("Add image");
const removeRows = () =>
  container.querySelectorAll<HTMLButtonElement>('[aria-label="Remove image"]');

describe("pictures on mobile", () => {
  it("adds them from the photo library with the attachment picker's own limits, and sends them", async () => {
    answers["dozoFeedback/status"] = status();
    answers["dozoFeedback/send"] = { sent: true };
    await render(<DozoFeedback />);
    await settle(() => expect(note()).not.toBeNull());
    picked(attachment("a.png"), attachment("b.jpg", "image/jpeg"));
    await act(async () => addRow()!.click());
    await settle(() => expect(removeRows()).toHaveLength(2));
    expect(ui.pick).toHaveBeenCalledWith(0, 3 * 1024 * 1024, 3);
    expect(container.querySelector("[data-footer]")!.textContent).toBe(
      "--\nFrom: ada@example.test\nImages: 2",
    );
    await act(async () => removeRows()[0]!.click());
    expect(removeRows()).toHaveLength(1);
    await write("Look");
    await act(async () => button("Send")!.click());
    await settle(() => expect(calls("dozoFeedback/send")).toHaveLength(1));
    expect(calls("dozoFeedback/send")[0]![1]).toEqual({
      message: "Look",
      images: ["data:image/jpeg;base64,AAAA"],
    });
  });

  it("stops offering to add at three", async () => {
    answers["dozoFeedback/status"] = status();
    await render(<DozoFeedback />);
    await settle(() => expect(note()).not.toBeNull());
    picked(attachment("1.png"), attachment("2.png"), attachment("3.png"));
    await act(async () => addRow()!.click());
    await settle(() => expect(removeRows()).toHaveLength(3));
    expect(addRow()).toBeUndefined();
  });

  it("says so when a choice was left out, or the library could not be opened", async () => {
    answers["dozoFeedback/status"] = status();
    await render(<DozoFeedback />);
    await settle(() => expect(note()).not.toBeNull());
    picked(attachment("a.gif", "image/gif"), attachment("b.png"));
    await act(async () => addRow()!.click());
    await settle(() => expect(ui.alert).toHaveBeenCalledWith("Couldn't use that image"));
    expect(removeRows()).toHaveLength(1);
    ui.alert.mockReset();
    ui.pick.mockResolvedValueOnce({
      attachments: [],
      skipped: [{ name: "c", reason: "over 3 MB" }],
    });
    await act(async () => addRow()!.click());
    await settle(() => expect(ui.alert).toHaveBeenCalledWith("Couldn't use that image"));
    ui.alert.mockReset();
    ui.pick.mockRejectedValueOnce(new Error("denied"));
    await act(async () => addRow()!.click());
    await settle(() => expect(ui.alert).toHaveBeenCalledWith("Couldn't use that image"));
  });

  it("offers none when the report is shared as text", async () => {
    answers["dozoFeedback/status"] = status({ mode: "save", address: "team@example.test" });
    await render(<DozoFeedback />);
    await settle(() => expect(note()).not.toBeNull());
    expect(addRow()).toBeUndefined();
  });

  it("keeps PNG, JPEG and WebP only", async () => {
    picked(
      attachment("a.png"),
      attachment("b.heic", "image/heic"),
      attachment("c.webp", "image/webp"),
    );
    const { images, refused } = await pickFeedbackImages(1);
    expect(images.map((image) => image.name)).toEqual(["a.png", "c.webp"]);
    expect(refused).toBe(true);
    expect(ui.pick).toHaveBeenCalledWith(1, 3 * 1024 * 1024, 3);
  });
});
