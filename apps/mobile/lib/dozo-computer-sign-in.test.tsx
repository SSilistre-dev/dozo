// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DozoComputerSignIn } from "../components/dozo-computer-sign-in";
import type { ComputerSignIn } from "./dozo-relay-sign-in";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const gone = vi.hoisted(() => ({ origins: new Set<string>(), listener: () => {} }));
const app = vi.hoisted(() => ({
  foreground: true,
  ask: vi.fn(),
  code: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock("react-native", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-router", () => ({ useRouter: () => router }));
vi.mock("./native/native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./platform/app-foreground", () => ({ useAppForeground: () => app.foreground }));
vi.mock("../lib/dozo-relay-sign-in", () => ({ askComputerForSignIn: app.ask }));
vi.mock("../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress(): void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../lib/dozo-relay-fetch", () => ({
  isRelayGone: (origin: string) => gone.origins.has(origin),
  relayApprovalCodeOf: app.code,
  subscribeRelayState: (listener: () => void) => {
    gone.listener = listener;
    return () => undefined;
  },
}));

const ORIGIN = "https://computer.example.invalid";
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  gone.origins.clear();
  app.foreground = true;
  app.ask.mockReset();
  app.ask.mockResolvedValue("sign-in-on-computer");
  app.code.mockReset();
  app.code.mockResolvedValue(null);
  router.push.mockClear();
  router.replace.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () => act(async () => root.render(<DozoComputerSignIn apiBase={ORIGIN} />));
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === label);

it("asks the computer for a sign-in and goes home with it, with no password asked", async () => {
  app.ask.mockResolvedValue("signed-in");
  await render();
  expect(router.replace).toHaveBeenCalledWith("/");
  expect(container.querySelector("input")).toBeNull();
});

it("shows the code to compare while the computer waits for the user's approval", async () => {
  const held = deferred<ComputerSignIn>();
  app.ask.mockReturnValue(held.promise);
  app.code.mockResolvedValue("012345");
  await render();
  expect(container.textContent).toContain("Approve this phone on your computer.");
  expect(container.textContent).toContain("012 345");
  await act(async () => held.resolve("signed-in"));
  expect(router.replace).toHaveBeenCalledWith("/");
});

it("drops a code that arrives after it left", async () => {
  const code = deferred<string | null>();
  app.code.mockReturnValue(code.promise);
  await render();
  act(() => root.unmount());
  await act(async () => code.resolve("012345"));
  root = createRoot(container);
});

it.each<[ComputerSignIn, string, boolean]>([
  ["sign-in-on-computer", "Sign in on your computer to use it here.", false],
  [
    "one-account",
    "Your computer has more than one account, so it cannot sign this phone in.",
    false,
  ],
  ["used", "Pair again to sign in on this phone.", true],
  ["not-approved", "This phone was not approved in time.", true],
  ["unreachable", "Could not reach your computer.", false],
])("says what the computer answered (%s)", async (result, text, pairAgain) => {
  app.ask.mockResolvedValue(result);
  await render();
  expect(container.textContent).toContain(text);
  expect(Boolean(button("Pair again"))).toBe(pairAgain);
  act(() => button("Use another server")?.click());
  expect(router.push).toHaveBeenCalledWith("/server");
});

it("asks again when the app comes back to the front, and not while it is away", async () => {
  app.foreground = false;
  await render();
  expect(app.ask).not.toHaveBeenCalled();
  app.foreground = true;
  await render();
  expect(app.ask).toHaveBeenCalledOnce();
});

it("says the computer could not be reached when asking fails outright", async () => {
  app.ask.mockRejectedValue(new Error("unreadable"));
  await render();
  expect(container.textContent).toContain("Could not reach your computer.");
});

it("drops an answer that arrives after it left", async () => {
  const held = deferred<ComputerSignIn>();
  app.ask.mockReturnValue(held.promise);
  await render();
  act(() => root.unmount());
  await act(async () => held.resolve("signed-in"));
  expect(router.replace).not.toHaveBeenCalled();
  root = createRoot(container);
});

it("offers to pair again once the computer removed this phone, and stops asking", async () => {
  await render();
  gone.origins.add(ORIGIN);
  act(() => gone.listener());
  expect(container.textContent).toContain("This phone was removed from your computer.");
  act(() => button("Pair again")?.click());
  expect(router.push).toHaveBeenCalledWith("/dozo-pair");
  expect(app.ask).toHaveBeenCalledOnce();
});
