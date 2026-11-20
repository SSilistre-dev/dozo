// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DozoComputerSignIn } from "../components/dozo-computer-sign-in";

const router = vi.hoisted(() => ({ push: vi.fn() }));
const gone = vi.hoisted(() => ({ origins: new Set<string>(), listener: () => {} }));

vi.mock("react-native", () => ({
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-router", () => ({ useRouter: () => router }));
vi.mock("../lib/native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress(): void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../lib/dozo-relay-fetch", () => ({
  isRelayGone: (origin: string) => gone.origins.has(origin),
  subscribeRelayGone: (listener: () => void) => {
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
  router.push.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === label);

it("asks for no password, and offers another server", async () => {
  await act(async () => root.render(<DozoComputerSignIn apiBase={ORIGIN} />));
  expect(container.textContent).toContain("Sign in on your computer to use it here.");
  expect(container.querySelector("input")).toBeNull();
  expect(button("Pair again")).toBeUndefined();
  act(() => button("Use another server")?.click());
  expect(router.push).toHaveBeenCalledWith("/server");
});

it("offers to pair again once the computer removed this phone", async () => {
  await act(async () => root.render(<DozoComputerSignIn apiBase={ORIGIN} />));
  gone.origins.add(ORIGIN);
  act(() => gone.listener());
  expect(container.textContent).toContain("This phone was removed from your computer.");
  act(() => button("Pair again")?.click());
  expect(router.push).toHaveBeenCalledWith("/dozo-pair");
});
