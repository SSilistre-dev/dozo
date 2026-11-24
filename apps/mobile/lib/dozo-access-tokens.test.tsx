// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree: the access token procedures exist once the brand rules apply.

type Header = { title?: string };
type MenuAction = { id: string; title: string; attributes?: { destructive?: boolean } };
type AlertButton = { text: string; style?: string; onPress?: () => void };

// A release build: Lingui registers no compiler of its own in production, so every string runs
// the way the app's `i18n.ts` sets it up, through the fallback compiler.
vi.mock("@lingui/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@lingui/core")>();
  vi.stubEnv("NODE_ENV", "production");
  const release = original.setupI18n({ locale: "en", messages: { en: {} } });
  vi.unstubAllEnvs();
  return { ...original, i18n: release };
});

const ui = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  copy: vi.fn(),
  confirmed: vi.fn(),
  platform: { OS: "android" },
  header: undefined as Header | undefined,
  menus: [] as { title: string; actions: MenuAction[]; press: (id: string) => void }[],
}));

vi.mock("react-native", () => ({
  Alert: { alert: ui.alert },
  StyleSheet: { create: <T,>(styles: T) => styles },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Platform: ui.platform,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: ui.copy }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    title,
    actions,
    onPressAction,
    children,
  }: {
    title: string;
    actions: MenuAction[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => {
    ui.menus.push({ title, actions, press: (id) => onPressAction({ nativeEvent: { event: id } }) });
    return <>{children}</>;
  },
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./native", () => ({
  native: { groupedPage: "grouped", secondaryLabel: "secondary" },
  useResolvedAppearance: () => "dark",
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./i18n", () => ({ dateLocaleForUi: () => "en-US", useUiLocale: () => "en" }));
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
vi.mock("../components/confirm-identity", () => ({
  useIdentityConfirmation: () => ({
    withIdentityConfirmation: <T,>(action: () => Promise<T>) => {
      ui.confirmed();
      return action();
    },
    identityDialog: <i data-identity="" />,
  }),
}));
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
vi.mock("../components/menu-picker", () => ({
  MenuPickerMenu: ({
    label,
    choices,
    value,
    onChange,
    children,
  }: {
    label: string;
    choices: { key: string; label: string }[];
    value: string;
    onChange: (key: string) => void;
    children?: ReactNode;
  }) => (
    <fieldset aria-label={label} data-value={value}>
      {choices.map((choice) => (
        <button type="button" key={choice.key} onClick={() => onChange(choice.key)}>
          {choice.label}
        </button>
      ))}
      {children}
    </fieldset>
  ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <ul>{children}</ul>,
  SettingsInputRow: ({
    accessibilityLabel,
    value,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
  SettingsRow: ({
    title,
    detail,
    value,
    dimmed,
    onPress,
    onAccessibilityAction,
  }: {
    title: string;
    detail?: string;
    value?: string;
    dimmed?: boolean;
    onPress?: () => void;
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  }) => (
    <li data-dimmed={dimmed ? "yes" : undefined}>
      <button
        type="button"
        onClick={onPress}
        onDoubleClick={() => onAccessibilityAction?.({ nativeEvent: { actionName: "revoke" } })}
      >
        {title}
      </button>
      {detail ? <small>{detail}</small> : null}
      {value ? <b>{value}</b> : null}
    </li>
  ),
}));

import DozoAccessTokens from "../app/(settings)/dozo-access-tokens";
import { revokeTitle, tokenDates } from "./dozo-access-tokens";
import { compileMissingMessages } from "./dozo-i18n-fallback";
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
const type = (label: string, value: string) =>
  act(async () => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

const token = (extra = {}) => ({
  id: "t1",
  name: "CI key",
  botId: null,
  botName: null,
  hint: "ab12",
  createdAt: "2026-11-01T12:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  ...extra,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  compileMissingMessages(i18n);
  i18n.load("en", {});
  i18n.activate("en");
  queryClient.clear();
  answers = {};
  ui.rpc.mockReset().mockImplementation(async (path: string, input: unknown) => {
    const value = answers[path];
    if (value instanceof Error) throw value;
    return typeof value === "function" ? value(input) : value;
  });
  for (const mock of [ui.alert, ui.copy, ui.confirmed]) mock.mockReset();
  ui.copy.mockResolvedValue(undefined);
  ui.platform.OS = "android";
  ui.header = undefined;
  ui.menus = [];
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("access tokens on mobile", () => {
  it("lists each token with its last four characters, bot, use and end", async () => {
    answers["dozoAccessTokens/list"] = [
      token(),
      token({
        id: "t2",
        name: "Deploy",
        botId: "b1",
        botName: "Ada",
        hint: "zz99",
        lastUsedAt: "2026-11-20T12:00:00.000Z",
        expiresAt: "2027-02-01T12:00:00.000Z",
      }),
    ];
    await render(<DozoAccessTokens />);
    await settle(() => expect(text()).toContain("CI key"));
    expect(ui.header?.title).toBe("Access tokens");
    expect(text()).toContain("…ab12, Never used");
    expect(text()).toContain("…zz99, Ada, Last used Nov 20, 2026, Expires Feb 1, 2027");
    expect(button("New token")).toBeDefined();
    expect(ui.menus.at(-1)!.actions).toEqual([
      { id: "revoke", title: "Revoke", attributes: { destructive: true } },
    ]);
  });

  it("lays the screen out for iOS and Android alike", async () => {
    ui.platform.OS = "ios";
    answers["dozoAccessTokens/list"] = [token()];
    await render(<DozoAccessTokens />);
    await settle(() => expect(text()).toContain("CI key"));
  });

  it("asks before revoking, then revokes and reads the list again", async () => {
    answers["dozoAccessTokens/list"] = [token()];
    await render(<DozoAccessTokens />);
    await settle(() => expect(text()).toContain("CI key"));

    answers["dozoAccessTokens/revoke"] = { ok: true };
    answers["dozoAccessTokens/list"] = [];
    await act(async () => ui.menus.find((menu) => menu.title === "CI key")!.press("revoke"));
    expect(calls("dozoAccessTokens/revoke")).toHaveLength(0);
    const [title, message, buttons] = ui.alert.mock.lastCall as [string, unknown, AlertButton[]];
    expect(title).toBe("Revoke CI key");
    expect(message).toBeUndefined();
    expect(buttons.map((entry) => entry.text)).toEqual(["Cancel", "Revoke"]);
    expect(buttons[1]!.style).toBe("destructive");
    await act(async () => buttons[1]!.onPress!());
    await settle(() => expect(text()).not.toContain("CI key"));
    expect(calls("dozoAccessTokens/revoke")[0]![1]).toEqual({ id: "t1" });
  });

  it("says when a revoke fails, and the screen reader action asks too", async () => {
    answers["dozoAccessTokens/list"] = [token()];
    await render(<DozoAccessTokens />);
    await settle(() => expect(text()).toContain("CI key"));
    await act(async () =>
      button("CI key")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    answers["dozoAccessTokens/revoke"] = new Error("Gone");
    const buttons = ui.alert.mock.lastCall![2] as AlertButton[];
    await act(async () => buttons[1]!.onPress!());
    await settle(() => expect(ui.alert).toHaveBeenCalledWith("Could not revoke token", "Gone"));
  });

  it("makes a token after the identity check and shows it once, with Copy", async () => {
    answers["dozoAccessTokens/list"] = [];
    answers["dozoAccessTokens/ownBots"] = [
      { id: "b1", name: "Ada" },
      { id: "b2", name: "Bo" },
    ];
    answers["dozoAccessTokens/create"] = { token: "dz_secret_value", accessToken: token() };
    await render(<DozoAccessTokens />);
    await act(async () => button("New token")!.click());
    await settle(() => expect(button("Ada")).toBeDefined());
    expect(button("Create")!.disabled).toBe(true);

    await type("Name", "  Laptop ");
    await act(async () => button("Ada")!.click());
    await act(async () => button("Never expires")!.click());
    expect(container.querySelector('[aria-label="Bot"]')!.getAttribute("data-value")).toBe("b1");
    expect(container.querySelector('[aria-label="Expires"]')!.getAttribute("data-value")).toBe(
      "never",
    );
    await act(async () => button("Create")!.click());
    await settle(() => expect(text()).toContain("dz_secret_value"));
    expect(ui.confirmed).toHaveBeenCalledOnce();
    expect(calls("dozoAccessTokens/create")[0]![1]).toEqual({
      name: "Laptop",
      botId: "b1",
      expiresInDays: null,
    });
    expect(text()).toContain("Copy it now. It won't be shown again.");

    await act(async () => button("Copy token")!.click());
    expect(ui.copy).toHaveBeenCalledWith("dz_secret_value");
    await settle(() => expect(button("Copied")).toBeDefined());

    await act(async () => button("Done")!.click());
    expect(text()).not.toContain("dz_secret_value");
    expect(button("New token")).toBeDefined();
    // The token is never cached with the list.
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain("dz_secret_value");
  });

  it("makes a 90 day token for every bot by default, and can be cancelled", async () => {
    answers["dozoAccessTokens/list"] = [];
    answers["dozoAccessTokens/ownBots"] = [];
    answers["dozoAccessTokens/create"] = { token: "dz_x", accessToken: token() };
    await render(<DozoAccessTokens />);
    await act(async () => button("New token")!.click());
    await act(async () => button("Cancel")!.click());
    expect(button("New token")).toBeDefined();
    await act(async () => button("New token")!.click());
    await type("Name", "Phone");
    await act(async () => button("Create")!.click());
    await settle(() => expect(text()).toContain("dz_x"));
    expect(calls("dozoAccessTokens/create")[0]![1]).toEqual({
      name: "Phone",
      expiresInDays: 90,
    });
  });

  it("says when making a token fails and keeps the form", async () => {
    answers["dozoAccessTokens/list"] = [];
    answers["dozoAccessTokens/ownBots"] = [];
    answers["dozoAccessTokens/create"] = new Error("Not confirmed");
    await render(<DozoAccessTokens />);
    await act(async () => button("New token")!.click());
    await type("Name", "Phone");
    await act(async () => button("Create")!.click());
    await settle(() =>
      expect(ui.alert).toHaveBeenCalledWith("Could not create token", "Not confirmed"),
    );
    expect(container.querySelector('input[aria-label="Name"]')).not.toBeNull();
  });
});

describe("access token words", () => {
  // No catalog lists these fork strings, so each reaches the screen through the fallback
  // compiler: the placeholders are filled, never shown as written.
  it("fills the placeholders of the strings the catalog does not list", () => {
    const dates = tokenDates(
      token({ lastUsedAt: "2026-11-20T12:00:00.000Z", expiresAt: "2027-02-01T12:00:00.000Z" }),
      "en-US",
    );
    expect(dates.used).toBe("Last used Nov 20, 2026");
    expect(dates.ends).toBe("Expires Feb 1, 2027");
    expect(revokeTitle("CI key")).toBe("Revoke CI key");
  });

  it("has no end for a token that never expires, and says never used", () => {
    const dates = tokenDates(token(), "en-US");
    expect(dates.ends).toBeNull();
    expect(dates.used).toBe("Never used");
  });
});
