// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DozoPairScreen from "../app/dozo-pair";
import type { ScreenHeaderAction } from "./screen-header";

const state = vi.hoisted(() => ({
  link: null as string | null,
  header: null as { title?: string; action?: ScreenHeaderAction | null } | null,
  input: null as null | { onChangeText(value: string): void; onSubmitEditing(): void },
  alerts: [] as {
    title: string;
    message: string;
    buttons: { text: string; onPress?: () => void }[];
  }[],
}));
const router = vi.hoisted(() => ({ replace: vi.fn() }));
const relay = vi.hoisted(() => ({
  pair: vi.fn(),
  adopt: vi.fn(),
  keepOnly: vi.fn(),
  save: vi.fn(async () => undefined),
  saveApiBase: vi.fn(
    async (url: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> => ({
      ok: true,
      url,
    }),
  ),
  confirm: vi.fn(async (): Promise<boolean> => true),
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, message: string, buttons: (typeof state.alerts)[number]["buttons"]) =>
      state.alerts.push({ title, message, buttons }),
  },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextInput: (props: {
    accessibilityLabel?: string;
    onChangeText(value: string): void;
    onSubmitEditing(): void;
  }) => {
    state.input = props;
    return <input aria-label={props.accessibilityLabel} readOnly />;
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-linking", () => ({ useLinkingURL: () => state.link }));
vi.mock("expo-router", () => ({ useRouter: () => router }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./screen-header", () => ({
  useScreenHeader: (header: typeof state.header) => {
    state.header = header;
  },
}));
vi.mock("./unsent-send-warning", () => ({ confirmUnsentSendLoss: relay.confirm }));
vi.mock("./api-server", () => ({ saveApiBase: relay.saveApiBase }));
vi.mock("./dozo-relay-connection", () => ({
  offerText: (input: string) => input.slice(input.indexOf("#") + 1),
  pairRelay: relay.pair,
}));
vi.mock("./dozo-relay-fetch", () => ({
  adoptRelayConnection: relay.adopt,
  keepOnlyRelayConnection: relay.keepOnly,
  relayDeps: {},
  relayPairingStore: { save: relay.save },
}));

const ORIGIN = "https://computer.example.invalid";
const pairing = { channel: "c" };
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.link = null;
  state.alerts.length = 0;
  relay.pair.mockReset();
  relay.pair.mockResolvedValue({ connection: { origin: ORIGIN }, pairing });
  relay.confirm.mockResolvedValue(true);
  relay.saveApiBase.mockResolvedValue({ ok: true, url: ORIGIN });
  for (const mock of [relay.adopt, relay.keepOnly, relay.save, router.replace]) mock.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => root.render(<DozoPairScreen />));
}

async function type(value: string) {
  await act(async () => state.input?.onChangeText(value));
}

async function press() {
  await act(async () => state.header?.action?.onPress());
}

it("pairs with a pasted code and makes the computer the app's server", async () => {
  await render();
  expect(state.header?.title).toBe("Your computer");
  expect(state.header?.action).toMatchObject({ label: "Connect", disabled: true });
  await type(" code ");
  await press();
  expect(relay.pair).toHaveBeenCalledWith(" code ", {});
  expect(relay.adopt).toHaveBeenCalledWith({ origin: ORIGIN });
  expect(relay.save).toHaveBeenCalledWith(pairing);
  expect(relay.saveApiBase).toHaveBeenCalledWith(ORIGIN);
  expect(relay.keepOnly).toHaveBeenCalledWith(ORIGIN);
  expect(router.replace).toHaveBeenCalledWith("/");
});

it("shows Connecting while it pairs and ignores a second press", async () => {
  const held = deferred<{ connection: { origin: string }; pairing: object }>();
  relay.pair.mockReturnValue(held.promise);
  await render();
  await type("code");
  await press();
  expect(state.header?.action).toMatchObject({ label: "Connecting…", busy: true });
  await press();
  await act(async () => state.input?.onSubmitEditing());
  expect(relay.pair).toHaveBeenCalledTimes(1);
  await act(async () => held.resolve({ connection: { origin: ORIGIN }, pairing }));
  expect(state.header?.action).toMatchObject({ label: "Connect" });
});

it.each([
  ["invalid", "That is not a pairing code."],
  ["expired", "This code has expired. Show a new one on your computer."],
  ["used", "This code was already used. Show a new one on your computer."],
  ["unreachable", "Could not reach your computer."],
  ["not-dozo", "Could not reach your computer."],
  [undefined, "Could not reach your computer."],
])("says why pairing failed (%s)", async (kind, text) => {
  relay.pair.mockRejectedValue(Object.assign(new Error("failed"), { kind }));
  await render();
  await type("code");
  await press();
  expect(container.textContent).toContain(text);
  expect(relay.saveApiBase).not.toHaveBeenCalled();
  await type("other");
  expect(container.textContent).not.toContain(text);
});

it("keeps the current server when unsent messages would be lost", async () => {
  relay.confirm.mockResolvedValue(false);
  await render();
  await type("code");
  await press();
  expect(relay.pair).not.toHaveBeenCalled();
});

it("shows why the server could not be switched", async () => {
  relay.saveApiBase.mockResolvedValue({ ok: false, error: "Could not save the server URL" });
  await render();
  await type("code");
  await act(async () => state.input?.onSubmitEditing());
  expect(container.textContent).toContain("Could not save the server URL");
  expect(router.replace).not.toHaveBeenCalled();
});

it("asks once before pairing from a link, and pairs only when the user agrees", async () => {
  state.link = "rakazo://dozo-pair#offer-1";
  await render();
  await render();
  expect(state.alerts).toHaveLength(1);
  const [ask] = state.alerts;
  expect(ask?.title).toBe("Connect to this computer?");
  expect(relay.pair).not.toHaveBeenCalled();
  await act(async () => ask?.buttons.find((button) => button.text === "Connect")?.onPress?.());
  expect(relay.pair).toHaveBeenCalledWith("offer-1", {});
});

it("asks nothing for a link without an offer", async () => {
  state.link = "rakazo://dozo-pair";
  await render();
  expect(state.alerts).toHaveLength(0);
});
