// @vitest-environment jsdom
import type { DozoAdminAccount as Account } from "@rakazo/contracts";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  user: vi.fn(),
  rename: vi.fn(),
  endSessions: vi.fn(),
  setSuspended: vi.fn(),
  deleteUser: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../lib/rpc", () => {
  const rpc = {
    dozoAdmin: {
      rename: api.rename,
      endSessions: api.endSessions,
      setSuspended: api.setSuspended,
      deleteUser: api.deleteUser,
    },
  };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoAdmin: {
      users: { key: () => ["users"] },
      user: {
        key: () => ["user"],
        queryOptions: ({ input }: { input: { userId: string } }) => ({
          queryKey: ["user", input.userId],
          queryFn: () => api.user(input),
        }),
      },
    },
  }),
}));
vi.mock("../lib/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));
// The plan and its dialog have their own test file.
vi.mock("./dozo-admin-plan", () => ({
  DozoPlanAction: ({ user }: { user: Account }) => <span data-testid="plan">{user.plan.tier}</span>,
}));
vi.mock("../components/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
    confirmLabel: ReactNode;
    confirmDisabled?: boolean;
    busy?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
  }) => (
    <div role="alertdialog">
      <h2>{props.title}</h2>
      <p>{props.description}</p>
      {props.children}
      <button type="button" disabled={props.busy} onClick={props.onCancel}>
        Cancel
      </button>
      <button
        type="button"
        data-confirm
        disabled={props.busy || props.confirmDisabled}
        onClick={props.onConfirm}
      >
        {props.confirmLabel}
      </button>
    </div>
  ),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span data-badge>{children}</span>,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  buttonVariants: () => "",
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  SectionHeading: ({ children }: { children?: ReactNode }) => <h3>{children}</h3>,
  toast: { error: api.toastError },
}));

import type * as Query from "../lib/query";
import { DozoAdminAccount } from "./dozo-admin-account";

const ada: Account = {
  id: "ada",
  email: "ada@example.test",
  name: "Ada",
  emailVerified: true,
  createdAt: "2026-01-03T00:00:00.000Z",
  suspended: false,
  banned: false,
  admin: false,
  plan: { tier: "pro", grantedUntil: "2027-02-01T23:59:59.000Z", ends: null },
  billing: {
    status: "active",
    trialEndsAt: null,
    currentPeriodEndsAt: "2026-12-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
  },
  freeUntil: "2026-12-10T00:00:00.000Z",
  storage: { usedBytes: 3 * 1024 * 1024, limitBytes: 2 * 1024 * 1024 * 1024 },
  spaces: [
    { id: "space-ada", name: "Home", owned: true },
    { id: "space-team", name: "Team", owned: false },
  ],
  bots: [{ id: "bot-1", name: "Scout" }],
  computers: [
    {
      id: "pc-1",
      running: true,
      ownMachine: false,
      runningSince: "2026-03-01T00:00:00.000Z",
      bots: ["Scout"],
    },
    { id: "pc-2", running: false, ownMachine: true, runningSince: null, bots: [] },
    { id: "pc-3", running: true, ownMachine: false, runningSince: null, bots: ["Quill"] },
  ],
  sessions: [
    {
      id: "s-1",
      createdAt: "2026-02-01T00:00:00.000Z",
      lastUsedAt: "2026-03-05T00:00:00.000Z",
      userAgent: "Phone",
    },
    {
      id: "s-2",
      createdAt: "2026-02-02T00:00:00.000Z",
      lastUsedAt: "2026-03-02T00:00:00.000Z",
      userAgent: null,
    },
  ],
};
const bare: Account = {
  ...ada,
  id: "bob",
  email: "bob@example.test",
  name: "Bob",
  emailVerified: false,
  plan: { tier: "standard", grantedUntil: null, ends: null },
  billing: null,
  freeUntil: null,
  storage: null,
  spaces: [],
  bots: [],
  computers: [],
  sessions: [],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function render(userId = "ada") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/admin/users/${userId}`]}>
          <Routes>
            <Route path="/admin" element={<div data-testid="members" />} />
            <Route path="/admin/users/:userId" element={<DozoAdminAccount ownId="admin" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const shown = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const texts = (testId: string) =>
  [...(shown(testId)?.querySelectorAll("li") ?? [])].map((node) => node.textContent);
const dialog = () => container.querySelector('[role="alertdialog"]');
const names = () => [...container.querySelectorAll("button")].map((node) => node.textContent);

function button(name: string) {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}

const click = (node: HTMLElement) => act(async () => node.click());

async function open(account: Account = ada) {
  api.user.mockResolvedValue(account);
  await render(account.id);
  await vi.waitFor(() => expect(shown("admin-account-identity")).toBeTruthy());
}

async function type(value: string) {
  const field = container.querySelector<HTMLInputElement>('input[aria-label="Name"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.rename.mockResolvedValue({ name: "Ada L." });
  api.endSessions.mockResolvedValue({ ok: true });
  api.setSuspended.mockResolvedValue({ suspended: true });
  api.deleteUser.mockResolvedValue({ ok: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
});

it("shows who it is, its plan's dates, its files, and where and how it works", async () => {
  await open();
  expect(api.user).toHaveBeenCalledWith({ userId: "ada" });
  expect(container.querySelector("h2")?.textContent).toBe("Ada");
  expect(shown("admin-account-identity")?.textContent).toBe(
    "ada@example.testEmail verifiedJoined Jan 3, 2026",
  );
  expect(shown("plan")?.textContent).toBe("pro");
  expect(shown("admin-account-dates")?.textContent).toBe(
    "Subscription activeRenews Dec 1, 2026Free period until Dec 10, 2026Granted until Feb 1, 2027",
  );
  expect(shown("admin-account-storage")?.textContent).toBe("3 MB of 2 GB used");
  expect(texts("admin-account-spaces")).toEqual(["HomeOwn", "TeamInvited"]);
  expect(texts("admin-account-bots")).toEqual(["Scout"]);
  expect(texts("admin-account-computers")).toEqual([
    "ScoutRunning since Mar 1, 2026",
    "pc-2StoppedOn their own machine",
    "QuillRunning",
  ]);
  expect(texts("admin-account-sessions")).toEqual([
    "PhoneLast used Mar 5, 2026Signed in Feb 1, 2026",
    "Unknown deviceLast used Mar 2, 2026Signed in Feb 2, 2026",
  ]);
  expect(names()).toEqual(["Rename", "Suspend", "Sign out everywhere", "Delete"]);
  expect(container.querySelector('a[href="/admin"]')?.textContent).toBe("Members");
});

it("leaves out what an account does not have, and says a trial or a cancelled period ends", async () => {
  await open(bare);
  expect(shown("admin-account-identity")?.textContent).toContain("Email not verified");
  for (const testId of [
    "admin-account-dates",
    "admin-account-storage",
    "admin-account-spaces",
    "admin-account-bots",
    "admin-account-computers",
    "admin-account-sessions",
  ])
    expect(shown(testId)).toBeNull();
  await act(async () => root.unmount());
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await open({
    ...bare,
    billing: {
      status: "trialing",
      trialEndsAt: "2026-04-01T00:00:00.000Z",
      currentPeriodEndsAt: "2026-04-01T00:00:00.000Z",
      cancelAtPeriodEnd: true,
    },
  });
  expect(shown("admin-account-dates")?.textContent).toBe(
    "Subscription on trialTrial ends Apr 1, 2026Ends Apr 1, 2026",
  );
});

it("says the subscription's state in words, whatever state it is in", async () => {
  const dates = async (status: string) => {
    api.user.mockResolvedValue({
      ...bare,
      billing: { status, trialEndsAt: null, currentPeriodEndsAt: null, cancelAtPeriodEnd: false },
    });
    await act(async () => client.invalidateQueries());
    await vi.waitFor(() => expect(api.user).toHaveBeenLastCalledWith({ userId: "bob" }));
    return vi.waitFor(() => {
      const text = shown("admin-account-dates")?.textContent;
      if (!text?.includes(expected[status] ?? "")) throw new Error(text);
      return text;
    });
  };
  const expected: Record<string, string> = {
    past_due: "Subscription payment due",
    canceled: "Subscription cancelled",
    incomplete: "Subscription inactive",
  };
  await open(bare);
  for (const status of Object.keys(expected)) expect(await dates(status)).toBe(expected[status]);
});

it("marks a suspended or banned account, and offers restoring a suspended one at once", async () => {
  await open({ ...ada, suspended: true });
  expect(container.querySelector("[data-badge]")?.textContent).toBe("Suspended");
  expect(names()).toEqual(["Rename", "Restore", "Sign out everywhere", "Delete"]);
  await click(button("Restore"));
  expect(api.setSuspended).toHaveBeenCalledWith({ userId: "ada", suspended: false });
  expect(dialog()).toBeNull();
  api.user.mockResolvedValue({ ...ada, suspended: true, banned: true });
  await act(async () => client.invalidateQueries());
  await vi.waitFor(() =>
    expect(container.querySelector("[data-badge]")?.textContent).toBe("Banned"),
  );
});

it("offers an admin account no suspending or deleting, and one's own account no actions", async () => {
  await open({ ...ada, admin: true });
  expect(names()).toEqual(["Rename", "Sign out everywhere"]);
  await act(async () => root.unmount());
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await open({ ...ada, id: "admin", admin: true });
  expect(names()).toEqual(["Rename"]);
});

it("renames from the current name, refuses an empty one, and reads the account again", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await open();
  await click(button("Rename"));
  await click(button("Cancel"));
  expect(dialog()).toBeNull();
  await click(button("Rename"));
  const field = container.querySelector<HTMLInputElement>('input[aria-label="Name"]');
  expect(field?.value).toBe("Ada");
  await type("   ");
  expect(button("Save").disabled).toBe(true);
  await type("  Ada L. ");
  await click(button("Save"));
  expect(api.rename).toHaveBeenCalledWith({ userId: "ada", name: "Ada L." });
  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["user"] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["users"] });
});

it("suspends, and signs out everywhere, only after the confirmation", async () => {
  await open();
  await click(button("Suspend"));
  expect(dialog()?.textContent).toContain("Suspend ada@example.test?");
  expect(api.setSuspended).not.toHaveBeenCalled();
  await click(button("Cancel"));
  expect(dialog()).toBeNull();
  await click(button("Suspend"));
  await click(dialog()?.querySelector("[data-confirm]") as HTMLElement);
  expect(api.setSuspended).toHaveBeenCalledWith({ userId: "ada", suspended: true });
  await vi.waitFor(() => expect(dialog()).toBeNull());

  await click(button("Sign out everywhere"));
  expect(dialog()?.textContent).toContain("Sign ada@example.test out everywhere?");
  expect(dialog()?.textContent).toContain("They can sign in again.");
  await click(button("Sign out"));
  expect(api.endSessions).toHaveBeenCalledWith({ userId: "ada" });
  await vi.waitFor(() => expect(dialog()).toBeNull());
});

it("deletes only after the confirmation, then goes back to the members", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await open();
  await click(button("Delete"));
  expect(dialog()?.textContent).toContain("This cannot be undone.");
  await click(dialog()?.querySelector("[data-confirm]") as HTMLElement);
  expect(api.deleteUser).toHaveBeenCalledWith({ userId: "ada" });
  await vi.waitFor(() => expect(shown("members")).toBeTruthy());
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["users"] });
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["user"] });
});

it("reports a refused change and keeps the dialog", async () => {
  api.endSessions.mockRejectedValue(new Error("Account not found"));
  await open();
  await click(button("Sign out everywhere"));
  await click(button("Sign out"));
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Account not found"));
  expect(dialog()).not.toBeNull();
});

it("offers a retry when the account cannot be read, and reads again when the window comes back", async () => {
  api.user.mockRejectedValueOnce(new Error("Account not found"));
  await render();
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Account not found"),
  );
  api.user.mockResolvedValue(ada);
  await click(button("Retry"));
  await vi.waitFor(() => expect(shown("admin-account-identity")).toBeTruthy());
  expect(api.user).toHaveBeenCalledTimes(2);
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await vi.waitFor(() => expect(api.user).toHaveBeenCalledTimes(3));
});
