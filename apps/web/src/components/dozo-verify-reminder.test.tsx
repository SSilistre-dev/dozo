// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type User = { id: string; email: string; emailVerified: boolean };
const api = vi.hoisted(() => ({
  session: { data: null as { user: User } | null },
  send: vi.fn(),
  capabilities: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  authClient: { useSession: () => api.session, sendVerificationEmail: api.send },
}));
vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: api.capabilities }));
vi.mock("../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("../lib/user-error", () => ({
  authErrorText: (error: { code?: string }, fallback: string) =>
    error.code === "TOO_MANY_REQUESTS" ? "Too many attempts" : fallback,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { DozoVerifyReminder } from "./dozo-verify-reminder";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const ada: User = { id: "u1", email: "ada@example.com", emailVerified: false };

async function render() {
  await act(async () => root.render(<DozoVerifyReminder />));
}
const line = () => container.querySelector('[role="status"]');
const resend = () =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Resend");
const dismiss = () => container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.sessionStorage.clear();
  api.session = { data: { user: ada } };
  api.send.mockReset();
  api.toastError.mockReset();
  api.capabilities.mockReset();
  api.capabilities.mockResolvedValue({ emailCode: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("DozoVerifyReminder", () => {
  it("asks an unverified account to verify, on a server that sends mail", async () => {
    await render();
    await vi.waitFor(() => expect(line()?.textContent).toBe("Verify your emailResend"));
  });

  it.each([
    ["signed out", null],
    ["verified", { ...ada, emailVerified: true }],
    ["a messaging account", { ...ada, email: "x@messaging.invalid" }],
  ])("shows nothing when %s", async (_case, user) => {
    api.session = { data: user ? { user } : null };
    await render();
    expect(line()).toBeNull();
    expect(api.capabilities).not.toHaveBeenCalled();
  });

  it("shows nothing on a server without mail, or when it cannot tell", async () => {
    api.capabilities.mockResolvedValue({ emailCode: false });
    await render();
    await vi.waitFor(() => expect(api.capabilities).toHaveBeenCalled());
    expect(line()).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    api.capabilities.mockRejectedValue(new Error("offline"));
    await render();
    expect(line()).toBeNull();
  });

  it("goes once the session says the address is verified", async () => {
    await render();
    await vi.waitFor(() => expect(line()).not.toBeNull());
    api.session = { data: { user: { ...ada, emailVerified: true } } };
    await render();
    expect(line()).toBeNull();
  });

  it("sends a new link once, then says it went", async () => {
    const answer = deferred<{ data: { status: boolean }; error: null }>();
    api.send.mockReturnValue(answer.promise);
    await render();
    await vi.waitFor(() => expect(resend()).toBeDefined());
    await act(async () => resend()?.click());
    expect(resend()?.disabled).toBe(true);
    expect(api.send).toHaveBeenCalledWith({ email: "ada@example.com" });
    await act(async () => answer.resolve({ data: { status: true }, error: null }));
    expect(line()?.textContent).toBe("Link sent");
    expect(resend()).toBeUndefined();
  });

  it("says why a link was not sent and offers it again", async () => {
    api.send.mockResolvedValueOnce({ data: null, error: { code: "TOO_MANY_REQUESTS" } });
    await render();
    await vi.waitFor(() => expect(resend()).toBeDefined());
    await act(async () => resend()?.click());
    expect(api.toastError).toHaveBeenCalledWith("Too many attempts");
    expect(resend()?.disabled).toBe(false);
    const failure = new TypeError("Failed to fetch");
    api.send.mockRejectedValueOnce(failure);
    await act(async () => resend()?.click());
    expect(api.toastError).toHaveBeenLastCalledWith("Could not send the link", failure);
  });

  it("stays closed for this tab and account once dismissed", async () => {
    await render();
    await vi.waitFor(() => expect(dismiss()).not.toBeNull());
    await act(async () => dismiss()?.click());
    expect(line()).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(line()).toBeNull();
    api.session = { data: { user: { ...ada, id: "u2" } } };
    await render();
    await vi.waitFor(() => expect(line()).not.toBeNull());
  });

  it("still closes when the tab has no storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      await render();
      await vi.waitFor(() => expect(dismiss()).not.toBeNull());
      await act(async () => dismiss()?.click());
      expect(line()).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
