// @vitest-environment jsdom
import type { ComputerStatus } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("../../lib/rpc", () => {
  const rpc = { dozoSiteSessions: { signIn: api.signIn, signOut: api.signOut } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoSiteSessions: {
      list: {
        key: () => ["sites"],
        queryOptions: ({ input }: { input: { botId: string } }) => ({
          queryKey: ["sites"],
          queryFn: () => api.list(input),
        }),
      },
    },
  }),
}));
vi.mock("../../lib/dozo-error-text", () => ({
  errorText: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("../../lib/relative-time", () => ({ formatRelativeTime: () => "1h ago" }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    title: ReactNode;
    confirmLabel: ReactNode;
    error?: ReactNode;
    onCancel: () => void;
    onConfirm: () => void;
  }) => (
    <div role="alertdialog">
      <p>{props.title}</p>
      {props.error ? <p role="alert">{props.error}</p> : null}
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
      <button type="button" data-confirm onClick={props.onConfirm}>
        {props.confirmLabel}
      </button>
    </div>
  ),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    type = "button",
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type={type as "button"} {...props} />
  ),
  Dialog: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div role="dialog">
      <button type="button" data-close onClick={() => onOpenChange(false)}>
        Close
      </button>
      {children}
    </div>
  ),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Spinner: () => <span role="status" />,
}));

import type * as Query from "../../lib/query";
import { SiteSessionsControl } from "./dozo-site-sessions";

const status = (over: Partial<ComputerStatus> = {}) =>
  ({ botId: "bot-1", state: "running", siteSessions: true, ...over }) as ComputerStatus;

const SITES = {
  sites: [
    {
      site: "example.com",
      since: "2026-11-19T09:00:00.000Z",
      lastUsedAt: "2026-11-19T10:00:00.000Z",
    },
    {
      // Just signed in: the browser has not saved its times yet.
      site: "alice.github.io",
      since: null,
      lastUsedAt: null,
    },
  ],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const signedIn = vi.fn();

async function render(computer: ComputerStatus | null = status()) {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SiteSessionsControl botId="bot-1" computer={computer} onSignedIn={signedIn} />
      </QueryClientProvider>,
    );
  });
}

const labelled = <T extends Element = HTMLButtonElement>(label: string) =>
  container.querySelector<T & Element>(`[aria-label="${label}"]`);
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);
const click = (node: Element | null | undefined) =>
  act(async () => {
    if (!node) throw new Error("Missing control");
    (node as HTMLElement).click();
  });

async function openDialog() {
  await render();
  await click(labelled("Signed-in sites"));
}

async function type(value: string) {
  const input = labelled<HTMLInputElement>("Site to sign in to");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [...Object.values(api), signedIn]) mock.mockReset();
  api.list.mockResolvedValue(SITES);
  api.signOut.mockResolvedValue({ ok: true });
  api.signIn.mockResolvedValue({ leaseId: "lease-1", expiresAt: "2026-11-19T12:00:00.000Z" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows only on a running computer of this bot whose provider can read its sessions", async () => {
  for (const computer of [
    null,
    status({ botId: "bot-2" }),
    status({ state: "stopped" }),
    status({ siteSessions: undefined }),
  ]) {
    await render(computer);
    expect(labelled("Signed-in sites")).toBeNull();
  }
  await render();
  expect(labelled("Signed-in sites")).toBeTruthy();
  expect(api.list).not.toHaveBeenCalled();
});

it("reads the sites when opened and lists them with their last use", async () => {
  await openDialog();
  await vi.waitFor(() => expect(container.textContent).toContain("example.com"));
  expect(api.list).toHaveBeenCalledWith({ botId: "bot-1" });
  expect(container.textContent).toContain("alice.github.io");
  expect(container.textContent).toContain("1h ago");
  expect(container.textContent).not.toContain("stay signed in for everyone");
  await click(container.querySelector("[data-close]"));
  expect(container.querySelector("[role=dialog]")).toBeNull();
});

it("says sign-ins are shared before a sign-in in a shared space", async () => {
  await render(status({ shared: true }));
  await click(labelled("Signed-in sites"));
  expect(container.textContent).toContain(
    "Sites you sign in to stay signed in for everyone in this space",
  );
});

it("shows an empty list and a failed read with a retry", async () => {
  api.list.mockResolvedValueOnce({ sites: [] });
  await openDialog();
  await vi.waitFor(() => expect(container.textContent).toContain("No sites yet"));
  expect(button("Sign out of all")).toBeUndefined();
  await act(async () => root.unmount());
  root = createRoot(container);
  api.list.mockRejectedValueOnce(new Error("Start the computer first."));
  await openDialog();
  await vi.waitFor(() => expect(container.textContent).toContain("Start the computer first."));
  await click(button("Retry"));
  await vi.waitFor(() => expect(container.textContent).toContain("example.com"));
});

it("signs out of one site after a confirmation, and of all sites", async () => {
  await openDialog();
  await vi.waitFor(() => expect(labelled("Sign out of example.com")).toBeTruthy());
  await click(labelled("Sign out of example.com"));
  expect(container.textContent).toContain("Sign out of example.com?");
  await click(button("Cancel"));
  expect(container.querySelector("[role=alertdialog]")).toBeNull();
  await click(labelled("Sign out of example.com"));
  await click(container.querySelector("[data-confirm]"));
  await vi.waitFor(() => expect(container.querySelector("[role=alertdialog]")).toBeNull());
  expect(api.signOut).toHaveBeenCalledWith({ botId: "bot-1", site: "example.com" });
  expect(api.list).toHaveBeenCalledTimes(2);
  await click(button("Sign out of all"));
  expect(container.textContent).toContain("Sign out of all sites?");
  await click(container.querySelector("[data-confirm]"));
  await vi.waitFor(() => expect(api.signOut).toHaveBeenLastCalledWith({ botId: "bot-1" }));
});

it("keeps the confirmation open with the reason when signing out fails", async () => {
  api.signOut.mockRejectedValueOnce(new Error("Someone else is using this computer"));
  await openDialog();
  await vi.waitFor(() => expect(labelled("Sign out of example.com")).toBeTruthy());
  await click(labelled("Sign out of example.com"));
  await click(container.querySelector("[data-confirm]"));
  await vi.waitFor(() =>
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "Someone else is using this computer",
    ),
  );
});

it("signs in with one click: control is taken, the dialog closes and the screen follows", async () => {
  await openDialog();
  expect(button("Sign in")?.disabled).toBe(true);
  await type("  example.com/login ");
  await click(button("Sign in"));
  await vi.waitFor(() => expect(signedIn).toHaveBeenCalledTimes(1));
  expect(api.signIn).toHaveBeenCalledWith({ botId: "bot-1", url: "example.com/login" });
  expect(container.querySelector("[role=dialog]")).toBeNull();
});

it("says why a sign-in could not take control", async () => {
  api.signIn.mockRejectedValueOnce(new Error("Stop the bot first"));
  await openDialog();
  await type("example.com");
  await act(async () => {
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true }));
  });
  await vi.waitFor(() => expect(container.textContent).toContain("Stop the bot first"));
  expect(signedIn).not.toHaveBeenCalled();
});
