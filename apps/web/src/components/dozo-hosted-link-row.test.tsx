// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ capabilities: vi.fn(), start: vi.fn(), assign: vi.fn() }));

vi.mock("../lib/auth/auth-capabilities", () => ({ fetchAuthCapabilities: api.capabilities }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("./settings/SettingsRows", () => ({
  SettingsRow: ({
    label,
    control,
    children,
  }: {
    label: ReactNode;
    control: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <span>{label}</span>
      {control}
      {children}
    </div>
  ),
}));
vi.mock("../pages/auth/Auth", () => ({ AuthFrame: () => null, submitClass: "" }));
vi.mock("../lib/auth/auth", () => ({ authClient: { useSession: () => ({}) } }));

import { DozoHostedLinkRow } from "./dozo-hosted-link-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function open() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <DozoHostedLinkRow />
      </QueryClientProvider>,
    ),
  );
}

const button = () => container.querySelector("button");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.capabilities.mockReset();
  api.start.mockReset();
  api.assign.mockReset();
  vi.stubGlobal("fetch", api.start);
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign: api.assign });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("linking a password account to the Dozo account", () => {
  it("is offered only where the server says its accounts may be linked", async () => {
    const answers = [{}, { hostedLogin: true }, { hostedLink: false }];
    for (const answer of answers) api.capabilities.mockResolvedValueOnce(answer);
    api.capabilities.mockRejectedValueOnce(new Error("offline"));
    for (let i = 0; i <= answers.length; i++) {
      act(() => root.unmount());
      root = createRoot(container);
      await open();
      expect(button()).toBeNull();
    }
    expect(api.capabilities).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["answer", (held: ReturnType<typeof deferred<object>>) => held.resolve({ hostedLink: true })],
    ["failure", (held: ReturnType<typeof deferred<object>>) => held.reject(new Error("offline"))],
  ])("drops an %s that arrives after settings closed", async (_, settle) => {
    const held = deferred<object>();
    api.capabilities.mockReturnValue(held.promise);
    await open();
    act(() => root.unmount());
    await act(async () => settle(held));
    expect(button()).toBeNull();
    root = createRoot(container);
  });

  it("starts the link for the signed-in account and opens the page the server names", async () => {
    api.capabilities.mockResolvedValue({ hostedLink: true });
    api.start.mockResolvedValue(Response.json({ url: "https://accounts.dozo.example/x" }));
    await open();
    expect(container.textContent).toContain("Dozo account");
    await act(async () => button()?.click());
    expect(api.start).toHaveBeenCalledWith("/api/auth/dozo/hosted-login/start", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ link: true }),
    });
    await vi.waitFor(() =>
      expect(api.assign).toHaveBeenCalledWith("https://accounts.dozo.example/x"),
    );
  });

  it("says when the link could not start", async () => {
    api.capabilities.mockResolvedValue({ hostedLink: true });
    api.start.mockResolvedValue(new Response("", { status: 409 }));
    await open();
    await act(async () => button()?.click());
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not continue"),
    );
    expect(api.assign).not.toHaveBeenCalled();
  });
});
