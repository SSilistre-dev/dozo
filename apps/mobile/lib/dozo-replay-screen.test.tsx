// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree: the replay procedures exist once the brand rules apply.

const ui = vi.hoisted(() => ({
  rpc: vi.fn(),
  share: vi.fn(async () => ({ action: "sharedAction" })),
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
    i18n: { date: (date: Date) => date.toISOString().slice(0, 10) },
  }),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => <p>loading</p>,
  Alert: { alert: vi.fn() },
  Image: ({ source }: { source: { uri: string } }) => <img src={source.uri} alt="" />,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Share: { share: ui.share },
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children }: { children?: ReactNode }) => <p role="alert">{children}</p>,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-secure-store", () => ({ getItemAsync: async () => null, setItemAsync: vi.fn() }));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ messageId: "m-1" }),
  useFocusEffect: () => undefined,
}));
vi.mock("./platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("./appearance/appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./native/native", () => ({
  native: { groupedPage: "grouped", fill: "fill", secondaryLabel: "label" },
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./navigation/screen-header", () => ({
  useScreenHeader: (header: typeof ui.header) => {
    ui.header = header;
  },
}));
vi.mock("./layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./api/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("./api/api-server", () => ({}));
vi.mock("./auth/api-auth", () => ({}));
vi.mock("./api/api-live", () => ({}));
vi.mock("./api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space",
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space" },
  }),
  rpc: ui.rpc,
}));
vi.mock("./api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../components/settings/settings-group", () => ({
  SettingsGroup: ({ children, footer }: { children?: ReactNode; footer?: string }) => (
    <ul>
      {children}
      {footer}
    </ul>
  ),
  SettingsRow: ({
    title,
    value,
    onPress,
  }: {
    title: string;
    value: string;
    onPress: () => void;
  }) => (
    <li>
      <button type="button" onClick={onPress}>
        {title} {value}
      </button>
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
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    </li>
  ),
}));

import { Alert } from "react-native";
import DozoReplay from "../app/dozo-replay";
import { queryClient } from "./query/query";

const steps = [
  {
    line: "Browser navigate · shop.example.test",
    frame: "data:image/png;base64,AA==",
    sensitive: false,
  },
  { line: "Browser act", frame: null, sensitive: true },
  { line: "Screenshot", frame: "data:image/png;base64,BB==", sensitive: true },
];
const link = {
  id: "l-1",
  kind: "replay",
  targetId: "r-1",
  createdAt: "2026-11-20T10:00:00.000Z",
  expiresAt: "2026-11-27T10:00:00.000Z",
  revokedAt: null,
};

let root: Root;
let container: HTMLDivElement;
let preview: { steps: typeof steps; links: (typeof link)[] };

async function render() {
  await act(async () => root.render(<DozoReplay />));
  await act(() => flush());
}
const switches = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const click = (node: Element | undefined) =>
  act(async () => {
    (node as HTMLElement).click();
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  preview = { steps, links: [] };
  ui.rpc.mockReset().mockImplementation(async (path: string) => {
    if (path === "dozoReplays/preview") return preview;
    if (path === "dozoReplays/publish") return { link, url: "https://app.example.test/s/token" };
    return { revoked: true };
  });
  ui.share.mockClear();
  ui.header = undefined;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

it("reviews every step and screenshot, publishes what stays on, and offers the link to share", async () => {
  await render();
  await vi.waitFor(() => expect(switches()).toHaveLength(5));
  expect(ui.header?.title).toBe("Share replay");
  // Three steps, then the two screenshots: the second one starts off after a sensitive step.
  expect(switches().map((box) => box.checked)).toEqual([true, true, true, true, false]);
  await click(switches()[1]);
  await click(switches()[4]);
  await act(async () => ui.header!.action!.onPress());
  await vi.waitFor(() =>
    expect(ui.share).toHaveBeenCalledWith({
      url: "https://app.example.test/s/token",
      message: "https://app.example.test/s/token",
    }),
  );
  expect(ui.rpc).toHaveBeenCalledWith(
    "dozoReplays/publish",
    { messageId: "m-1", omit: [1], frames: [0, 2] },
    expect.anything(),
  );
});

it("cannot publish with every step left out", async () => {
  preview = { steps: [steps[1]!], links: [] };
  await render();
  await vi.waitFor(() => expect(switches()).toHaveLength(1));
  await click(switches()[0]);
  expect(ui.header?.action?.disabled).toBe(true);
});

it("revokes one of the reply's live links", async () => {
  preview = { steps, links: [link] };
  await render();
  const row = () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Expires"));
  await vi.waitFor(() => expect(row()?.textContent).toBe("Expires 2026-11-27 Revoke"));
  await click(row());
  await vi.waitFor(() =>
    expect(ui.rpc).toHaveBeenCalledWith("dozoShareLinks/revoke", { id: "l-1" }, expect.anything()),
  );
});

it("says why a reply cannot be shared", async () => {
  ui.rpc.mockRejectedValue(new Error("Only a finished reply can be shared"));
  await render();
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Only a finished reply can be shared",
    ),
  );
});

it("says so when a revoke fails, and why a publish failed", async () => {
  preview = { steps, links: [link] };
  ui.rpc.mockImplementation(async (path: string) => {
    if (path === "dozoReplays/preview") return preview;
    throw new Error(path === "dozoReplays/publish" ? "Too many links" : "No");
  });
  await render();
  const row = () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Expires"));
  await vi.waitFor(() => expect(row()).toBeDefined());
  await click(row());
  await vi.waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("No"));
  await act(async () => ui.header!.action!.onPress());
  await vi.waitFor(() => expect(container.textContent).toContain("Too many links"));
});
