// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userId: "user-a" as string | undefined,
  me: vi.fn(),
  track: vi.fn(),
  chatRedirect: null as string | null | undefined,
}));
vi.mock("./Shell", () => ({ ShellPage: () => <div data-testid="upstream-shell" /> }));
vi.mock("./shell/dozo-trust-bot", () => ({ DozoTrustBotHost: () => null }));
vi.mock("./shell/dozo-bot-chats", async () => {
  const { Navigate, useSearchParams } = await import("react-router-dom");
  return {
    useDozoOpenChat: () => useSearchParams()[0].get("chat") ?? undefined,
    // The list said the chat is not there (a path), is still loading (undefined), or is (null).
    DozoChatAddress: ({ children }: { children: ReactNode }) =>
      mocks.chatRedirect ? (
        <Navigate to={mocks.chatRedirect} replace />
      ) : mocks.chatRedirect === undefined ? (
        <p>checking</p>
      ) : (
        children
      ),
  };
});
vi.mock("../lib/auth", () => ({
  authClient: {
    useSession: () => ({ data: mocks.userId ? { user: { id: mocks.userId } } : null }),
  },
}));
vi.mock("../lib/rpc", () => ({
  rpc: { me: mocks.me, dozoEvents: { track: mocks.track } },
}));

import { forgetEventServer } from "../lib/dozo-event-sender";
import { markSignupStarted } from "../lib/dozo-signup-start";
import { ShellPage } from "./dozo-shell";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

function Where() {
  const { pathname, search } = useLocation();
  return <output>{pathname + search}</output>;
}

async function open(path: string) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/app" element={<ShellPage />} />
          <Route path="/app/:botId" element={<ShellPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
async function reopen(path: string) {
  act(() => root.unmount());
  root = createRoot(container);
  await open(path);
}
const where = () => container.querySelector("output")?.textContent;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.userId = "user-a";
  mocks.chatRedirect = null;
  mocks.me.mockReset().mockResolvedValue({ productEvents: true });
  mocks.track.mockReset().mockResolvedValue({ ok: true });
  forgetEventServer();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

it("is upstream's shell and asks nothing of the server", async () => {
  await open("/app/bot-1");
  expect(container.querySelector('[data-testid="upstream-shell"]')).not.toBeNull();
  expect(where()).toBe("/app/bot-1");
  expect(mocks.me).not.toHaveBeenCalled();
});

it("reports when this tab opened the sign-up form, once the account is signed in", async () => {
  mocks.userId = undefined;
  markSignupStarted();
  await open("/app");
  expect(mocks.track).not.toHaveBeenCalled();
  mocks.userId = "user-a";
  await reopen("/app");
  await reopen("/app");
  await vi.waitFor(() => expect(mocks.track).toHaveBeenCalled());
  expect(mocks.track.mock.calls).toEqual([
    [{ name: "signup_started", startedAt: expect.any(String) }],
  ]);
});

it("opens the bot's main chat at an address naming none of its open extra chats", async () => {
  mocks.chatRedirect = "/app/bot-1";
  await open("/app/bot-1?chat=gone");
  await vi.waitFor(() => expect(where()).toBe("/app/bot-1"));
});

it("waits for the chat list before opening an address that names an extra chat", async () => {
  mocks.chatRedirect = undefined;
  await open("/app/bot-1?chat=chat-1");
  await vi.waitFor(() => expect(container.textContent).toContain("checking"));
  expect(container.querySelector('[data-testid="upstream-shell"]')).toBeNull();
});

it("opens an address naming one of the bot's open extra chats", async () => {
  await open("/app/bot-1?chat=chat-1");
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="upstream-shell"]')).not.toBeNull(),
  );
  expect(where()).toBe("/app/bot-1?chat=chat-1");
});
