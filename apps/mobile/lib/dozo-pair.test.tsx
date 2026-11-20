// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DozoPairScreen from "../app/dozo-pair";
import type { ScreenHeaderAction } from "./screen-header";

type Button = { text: string; onPress?: () => void };
const state = vi.hoisted(() => ({
  link: null as string | null,
  header: null as { title?: string; action?: ScreenHeaderAction | null } | null,
  input: null as null | { onChangeText(value: string): void; onSubmitEditing(): void },
  alerts: [] as {
    title: string;
    message: string;
    buttons: Button[];
    options: { onDismiss?: () => void };
  }[],
}));
const router = vi.hoisted(() => ({ replace: vi.fn() }));
const OFFER = vi.hoisted(() => ({ relay: "https://relay.dozo.bot" }));
const relay = vi.hoisted(() => ({
  read: vi.fn(),
  pair: vi.fn(),
  adopt: vi.fn(),
  forget: vi.fn(),
  keepOnly: vi.fn(),
  save: vi.fn(async () => undefined),
  saveApiBase: vi.fn(
    async (url: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> => ({
      ok: true,
      url,
    }),
  ),
  confirm: vi.fn(async (): Promise<boolean> => true),
  token: vi.fn(async () => ""),
  flush: vi.fn(async () => undefined),
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, message: string, buttons: Button[], options: { onDismiss?(): void }) =>
      state.alerts.push({ title, message, buttons, options }),
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
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.invalid",
  flushPendingSignOut: relay.flush,
}));
vi.mock("./session", () => ({ loadSessionToken: relay.token }));
vi.mock("./dozo-relay-endpoint", () => ({ displayApiHost: (url: string) => new URL(url).host }));
vi.mock("./unsent-send-warning", () => ({ confirmUnsentSendLoss: relay.confirm }));
vi.mock("./api-server", () => ({ saveApiBase: relay.saveApiBase }));
vi.mock("./dozo-relay-connection", () => ({ readPairingOffer: relay.read, pairRelay: relay.pair }));
vi.mock("./dozo-relay-fetch", () => ({
  adoptRelayConnection: relay.adopt,
  DEFAULT_RELAY: "https://relay.dozo.bot",
  forgetRelayConnection: relay.forget,
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
  for (const mock of Object.values(relay)) mock.mockClear();
  relay.read.mockReset();
  relay.read.mockImplementation((input: string) => ({ ...OFFER, input }));
  relay.pair.mockReset();
  relay.pair.mockResolvedValue({ connection: { origin: ORIGIN }, pairing });
  relay.confirm.mockResolvedValue(true);
  relay.token.mockResolvedValue("");
  relay.saveApiBase.mockResolvedValue({ ok: true, url: ORIGIN });
  router.replace.mockClear();
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

async function answer(text: string) {
  const ask = state.alerts.at(-1);
  await act(async () => ask?.buttons.find((button) => button.text === text)?.onPress?.());
}

it("checks a pasted code, asks once, pairs, and stores the pairing only after the switch", async () => {
  await render();
  expect(state.header?.title).toBe("Your computer");
  expect(state.header?.action).toMatchObject({ label: "Connect", disabled: true });
  await type(" code ");
  await press();
  expect(relay.read).toHaveBeenCalledWith(" code ", expect.any(Number));
  expect(state.alerts).toHaveLength(1);
  expect(state.alerts[0]?.title).toBe("Connect to this computer?");
  expect(state.alerts[0]?.message).toBe("Only connect to a computer you own.");
  expect(relay.pair).not.toHaveBeenCalled();
  await answer("Connect");
  expect(relay.pair).toHaveBeenCalledWith({ ...OFFER, input: " code " }, {});
  expect(relay.adopt).toHaveBeenCalledWith({ origin: ORIGIN });
  expect(relay.saveApiBase).toHaveBeenCalledWith(ORIGIN);
  expect(relay.save).toHaveBeenCalledWith(pairing);
  expect(relay.saveApiBase.mock.invocationCallOrder[0]).toBeLessThan(
    relay.save.mock.invocationCallOrder[0] as number,
  );
  expect(relay.keepOnly).toHaveBeenCalledWith(ORIGIN);
  // The computer paired before is signed out through its own connection, before it closes.
  expect(relay.flush).toHaveBeenCalledWith(true);
  expect(relay.flush.mock.invocationCallOrder[0]).toBeLessThan(
    relay.keepOnly.mock.invocationCallOrder[0] as number,
  );
  expect(router.replace).toHaveBeenCalledWith("/");
});

it("names a relay that is not this build's own, and the server the user will be signed out of", async () => {
  relay.read.mockReturnValue({ relay: "https://relay.other.invalid" });
  relay.token.mockResolvedValue("token");
  await render();
  await type("code");
  await press();
  expect(state.alerts[0]?.message.split("\n")).toEqual([
    "Uses the relay at relay.other.invalid.",
    "You will be signed out of app.example.invalid.",
    "Only connect to a computer you own.",
  ]);
});

it("does nothing when the user cancels or dismisses the question, or keeps unsent messages", async () => {
  await render();
  await type("code");
  await press();
  await answer("Cancel");
  await press();
  await act(async () => state.alerts.at(-1)?.options.onDismiss?.());
  relay.confirm.mockResolvedValue(false);
  await press();
  await answer("Connect");
  expect(relay.pair).not.toHaveBeenCalled();
});

it("says a code is wrong before asking anything", async () => {
  relay.read.mockImplementation(() => {
    throw Object.assign(new Error("bad"), { kind: "expired" });
  });
  await render();
  await type("code");
  await act(async () => state.input?.onSubmitEditing());
  expect(state.alerts).toHaveLength(0);
  expect(container.textContent).toContain(
    "This code has expired. Show a new one on your computer.",
  );
});

it("keeps the app's server and the stored pairing when the switch fails", async () => {
  relay.saveApiBase.mockResolvedValue({ ok: false, error: "Could not save the server URL" });
  await render();
  await type("code");
  await press();
  await answer("Connect");
  expect(relay.forget).toHaveBeenCalledWith(ORIGIN);
  expect(relay.save).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Could not save the server URL");
});

it("shows Connecting while it pairs and ignores a second press", async () => {
  const held = deferred<{ connection: { origin: string }; pairing: object }>();
  relay.pair.mockReturnValue(held.promise);
  await render();
  await type("code");
  await press();
  await answer("Connect");
  expect(state.header?.action).toMatchObject({ label: "Connecting…", busy: true });
  await press();
  expect(state.alerts).toHaveLength(1);
  await act(async () => held.resolve({ connection: { origin: ORIGIN }, pairing }));
  expect(state.header?.action).toMatchObject({ label: "Connect" });
});

it.each([
  ["invalid", "That is not a pairing code."],
  ["used", "This code was already used. Show a new one on your computer."],
  ["unreachable", "Could not reach your computer."],
  ["not-dozo", "Could not reach your computer."],
  [undefined, "Could not reach your computer."],
])("says why pairing failed (%s)", async (kind, text) => {
  relay.pair.mockRejectedValue(Object.assign(new Error("failed"), { kind }));
  await render();
  await type("code");
  await press();
  await answer("Connect");
  expect(container.textContent).toContain(text);
  expect(relay.saveApiBase).not.toHaveBeenCalled();
  await type("other");
  expect(container.textContent).not.toContain(text);
});

it("acts on the pairing link once, and on no other link", async () => {
  state.link = "rakazo://dozo-pair#offer-1";
  await render();
  await render();
  expect(state.alerts).toHaveLength(1);
  expect(relay.read).toHaveBeenCalledWith("offer-1", expect.any(Number));
  await answer("Cancel");
  // Opening the screen again later never brings that link back.
  act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(state.alerts).toHaveLength(1);

  for (const link of [
    "rakazo://anything#offer-2",
    "rakazo://dozo-pair/more#offer-3",
    "https://dozo-pair#offer-4",
    "rakazo://dozo-pair",
    "rakazo://dozo-pair#bad offer",
  ]) {
    state.link = link;
    await render();
  }
  expect(state.alerts).toHaveLength(1);
  state.link = "rakazo://dozo-pair/#offer-5";
  await render();
  expect(state.alerts).toHaveLength(2);
});
