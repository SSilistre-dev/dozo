// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  users: vi.fn(),
  computers: vi.fn(),
  setSuspended: vi.fn(),
  stopComputer: vi.fn(),
  bans: vi.fn(),
  ban: vi.fn(),
  unban: vi.fn(),
  deleteUser: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../lib/rpc", () => {
  const rpc = {
    dozoAdmin: {
      setSuspended: api.setSuspended,
      stopComputer: api.stopComputer,
      ban: api.ban,
      unban: api.unban,
      deleteUser: api.deleteUser,
    },
  };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    me: { queryOptions: () => ({ queryKey: ["me"], queryFn: () => api.me() }) },
    dozoAdmin: {
      users: {
        key: () => ["users"],
        infiniteOptions: (options: {
          input: (cursor: string | null) => object;
          [key: string]: unknown;
        }) => ({
          ...options,
          queryKey: ["users", options.input(null)],
          queryFn: ({ pageParam }: { pageParam: string | null }) =>
            api.users(options.input(pageParam)),
        }),
      },
      computers: {
        key: () => ["computers"],
        queryOptions: () => ({ queryKey: ["computers"], queryFn: () => api.computers() }),
      },
      bans: {
        key: () => ["bans"],
        queryOptions: () => ({ queryKey: ["bans"], queryFn: () => api.bans() }),
      },
    },
  }),
}));
vi.mock("../lib/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));
// The plan beside each account has its own test file.
vi.mock("./dozo-admin-plan", () => ({ DozoPlanAction: () => null }));
vi.mock("./NotFound", () => ({ NotFoundPage: () => <div data-testid="not-found" /> }));
vi.mock("../components/PageLoading", () => ({
  PageLoading: () => <div data-testid="page-loading" />,
}));
vi.mock("../components/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    title: ReactNode;
    description: ReactNode;
    confirmLabel: ReactNode;
    onCancel: () => void;
    onConfirm: () => void;
  }) => (
    <div role="alertdialog">
      <h2>{props.title}</h2>
      <p>{props.description}</p>
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
      <button type="button" data-confirm onClick={props.onConfirm}>
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
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
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
    ListSearchInput: (props: {
      query: string;
      setQuery: (query: string) => void;
      label: string;
    }) => (
      <input
        aria-label={props.label}
        value={props.query}
        onChange={(event) => props.setQuery(event.target.value)}
      />
    ),
    SectionHeading: Pass,
    Spinner: () => <span role="status" />,
    toast: { error: api.toastError },
  };
});

import type * as Query from "../lib/query";
import { DozoAdminPage } from "./dozo-admin";

const owner = {
  id: "admin",
  email: "owner@example.test",
  name: "Owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-03-01T00:00:00.000Z",
  bots: 1,
  runningComputers: 0,
  suspended: false,
  banned: false,
};
const ada = {
  ...owner,
  id: "ada",
  email: "ada@example.test",
  name: "Ada",
  bots: 2,
  runningComputers: 1,
};
const bob = {
  ...owner,
  id: "bob",
  email: "bob@example.test",
  name: "Bob",
  lastSeenAt: null,
  suspended: true,
};
const page = (users: object[], nextCursor: string | null = null) => ({
  signupsOpen: false,
  total: 3,
  users,
  nextCursor,
});
const computer = {
  id: "pc-1",
  email: "ada@example.test",
  bots: ["Scout", "Quill"],
  runningSince: "2026-03-01T10:00:00.000Z",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <DozoAdminPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const shown = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
const row = (label: string) => container.querySelector(`li[aria-label="${label}"]`);
// A person's computer is listed under the same address, above the accounts.
const userRow = (label: string) =>
  shown("admin-users")?.querySelector(`li[aria-label="${label}"]`) ?? null;

function button(name: string, within: ParentNode | null = container) {
  const found = [...(within?.querySelectorAll("button") ?? [])].find(
    (node) => node.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}

const click = (node: HTMLElement) => act(async () => node.click());

async function open() {
  await render();
  await vi.waitFor(() => expect(shown("admin-users")).toBeTruthy());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.me.mockResolvedValue({ isAdmin: true, userId: "admin" });
  api.users.mockResolvedValue(page([ada, bob, owner]));
  api.computers.mockResolvedValue({ total: 1, computers: [computer] });
  api.setSuspended.mockResolvedValue({ suspended: true });
  api.stopComputer.mockResolvedValue({ ok: true });
  api.bans.mockResolvedValue({ bans: [] });
  api.ban.mockResolvedValue({ value: "ada@example.test" });
  api.unban.mockResolvedValue({ ok: true });
  api.deleteUser.mockResolvedValue({ ok: true });
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

it("shows anyone but an admin the page an unknown address shows, and reads nothing", async () => {
  const me = deferred<{ isAdmin: boolean }>();
  api.me.mockReturnValue(me.promise);
  await render();
  expect(shown("page-loading")).toBeTruthy();
  await act(async () => me.resolve({ isAdmin: false }));
  await vi.waitFor(() => expect(shown("not-found")).toBeTruthy());
  expect(container.textContent).not.toContain("Admin");
  expect(api.users).not.toHaveBeenCalled();
  expect(api.computers).not.toHaveBeenCalled();
});

it("shows the status line, the running computers and the accounts", async () => {
  await open();
  expect(shown("admin-status")?.textContent).toBe("Sign-up closed3 users1 computer running");
  expect(row("ada@example.test")?.textContent).toContain("Scout, Quill");
  const users = shown("admin-users");
  const adaRow = users?.querySelector('li[aria-label="ada@example.test"]');
  expect(adaRow?.textContent).toContain("Ada");
  expect(adaRow?.textContent).toContain("Joined Jan 1, 2026");
  expect(adaRow?.textContent).toContain("Last seen Mar 1, 2026");
  expect(adaRow?.textContent).toContain("2 bots");
  expect(adaRow?.textContent).toContain("1 computer");
  expect(row("bob@example.test")?.textContent).not.toContain("Last seen");
  expect(row("bob@example.test")?.querySelector("[data-badge]")?.textContent).toBe("Suspended");
  // Nobody suspends themselves.
  expect(row("owner@example.test")?.querySelector("button")).toBeNull();
  expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
    "/app",
    "/admin/access",
    "/admin/plugins",
  ]);
});

it("says so when sign-up is open, and leaves out the computers when none runs", async () => {
  api.users.mockResolvedValue({ ...page([owner]), signupsOpen: true, total: 1 });
  api.computers.mockResolvedValue({ total: 0, computers: [] });
  await open();
  expect(shown("admin-status")?.textContent).toBe("Sign-up open1 user0 computers running");
  expect(shown("admin-computers")).toBeNull();
});

it("suspends only after the confirmation", async () => {
  await open();
  const users = shown("admin-users");
  await click(button("Suspend", users));
  expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "Suspend ada@example.test?",
  );
  await click(button("Cancel"));
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(api.setSuspended).not.toHaveBeenCalled();

  await click(button("Suspend", users));
  await click(container.querySelector<HTMLElement>("[data-confirm]") as HTMLElement);
  expect(api.setSuspended).toHaveBeenCalledExactlyOnceWith({ userId: "ada", suspended: true });
  // The lists are read again once the change is saved.
  await vi.waitFor(() => expect(api.users).toHaveBeenCalledTimes(2));
});

it("restores a suspended account at once", async () => {
  await open();
  await click(button("Restore"));
  expect(api.setSuspended).toHaveBeenCalledExactlyOnceWith({ userId: "bob", suspended: false });
});

it("stops a computer after the confirmation, and reports a refusal", async () => {
  await open();
  await click(button("Stop"));
  expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "Stop this computer?",
  );
  await click(container.querySelector<HTMLElement>("[data-confirm]") as HTMLElement);
  expect(api.stopComputer).toHaveBeenCalledExactlyOnceWith({ computerId: "pc-1" });

  api.stopComputer.mockRejectedValue(new Error("Computer is busy"));
  await vi.waitFor(() => expect(button("Stop").disabled).toBe(false));
  await click(button("Stop"));
  await click(container.querySelector<HTMLElement>("[data-confirm]") as HTMLElement);
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Computer is busy"));
});

it("reports a failed account change in its own words", async () => {
  api.setSuspended.mockRejectedValue(new Error(""));
  await open();
  await click(button("Restore"));
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("Could not change the account"),
  );
  api.stopComputer.mockRejectedValue(new Error(""));
  await vi.waitFor(() => expect(button("Stop").disabled).toBe(false));
  await click(button("Stop"));
  await click(container.querySelector<HTMLElement>("[data-confirm]") as HTMLElement);
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("Could not stop the computer"),
  );
});

it("bans an account only after the confirmation, and marks a banned one", async () => {
  api.users.mockResolvedValue(page([ada, { ...bob, banned: true }, owner]));
  await open();
  const bobRow = row("bob@example.test");
  expect(bobRow?.querySelector("[data-badge]")?.textContent).toBe("Banned");
  expect([...(bobRow?.querySelectorAll("button") ?? [])].map((node) => node.textContent)).toEqual([
    "Restore",
    "Delete",
  ]);
  await click(button("Ban", userRow("ada@example.test")));
  expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "Ban ada@example.test?",
  );
  await click(button("Cancel"));
  expect(api.ban).not.toHaveBeenCalled();
  await click(button("Ban", userRow("ada@example.test")));
  await click(container.querySelector<HTMLElement>("[data-confirm]") as HTMLElement);
  expect(api.ban).toHaveBeenCalledExactlyOnceWith({ userId: "ada" });
  await vi.waitFor(() => expect(api.bans).toHaveBeenCalledTimes(2));
});

it("deletes an account only after the confirmation", async () => {
  await open();
  await click(button("Delete", userRow("ada@example.test")));
  const dialog = container.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("Delete ada@example.test?");
  expect(dialog?.textContent).toContain("This cannot be undone.");
  await click(button("Cancel"));
  expect(api.deleteUser).not.toHaveBeenCalled();
  await click(button("Delete", userRow("ada@example.test")));
  await click(container.querySelector<HTMLElement>("[data-confirm]") as HTMLElement);
  expect(api.deleteUser).toHaveBeenCalledExactlyOnceWith({ userId: "ada" });
  await vi.waitFor(() => expect(api.users).toHaveBeenCalledTimes(2));
});

it("adds an address or a domain to the ban list, and removes one", async () => {
  api.bans.mockResolvedValue({
    bans: [{ value: "corp.test", createdAt: "2026-02-01T00:00:00.000Z" }],
  });
  await open();
  expect(row("corp.test")?.textContent).toContain("Feb 1, 2026");
  const field = container.querySelector<HTMLInputElement>('input[aria-label="Email or domain"]');
  const submit = button("Ban", field?.closest("form"));
  // Nothing to ban yet.
  expect(submit.disabled).toBe(true);
  await act(async () => field?.closest("form")?.requestSubmit());
  expect(api.ban).not.toHaveBeenCalled();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      field,
      " Spam@Evil.test ",
    );
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(submit);
  expect(api.ban).toHaveBeenCalledExactlyOnceWith({ value: "Spam@Evil.test" });
  await vi.waitFor(() => expect(field?.value).toBe(""));

  await click(button("Remove", row("corp.test")));
  expect(api.unban).toHaveBeenCalledExactlyOnceWith({ value: "corp.test" });
});

it("leaves out the list while nothing is banned", async () => {
  await open();
  expect(shown("admin-bans")).toBeNull();
  expect(container.querySelector('input[aria-label="Email or domain"]')).toBeTruthy();
});

it("loads the next page from the cursor", async () => {
  api.users.mockResolvedValueOnce(page([ada], "bob")).mockResolvedValueOnce(page([bob]));
  await open();
  await click(button("Load more"));
  expect(api.users).toHaveBeenLastCalledWith({ cursor: "bob" });
  await vi.waitFor(() => expect(row("bob@example.test")).toBeTruthy());
  expect(container.textContent).not.toContain("Load more");
});

it("searches by email on the server", async () => {
  await open();
  const field = container.querySelector<HTMLInputElement>('input[aria-label="Search by email"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, " ada ");
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await vi.waitFor(() => expect(api.users).toHaveBeenLastCalledWith({ query: "ada" }));
});

it("reads again when the window comes back, and never on a timer", async () => {
  await open();
  expect(api.users).toHaveBeenCalledTimes(1);
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await vi.waitFor(() => expect(api.users).toHaveBeenCalledTimes(2));
  expect(api.computers).toHaveBeenCalledTimes(2);
});

it("offers a retry when the page cannot be read", async () => {
  api.computers.mockRejectedValueOnce(new Error(""));
  await render();
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load the admin page",
    ),
  );
  await click(button("Retry"));
  await vi.waitFor(() => expect(shown("admin-users")).toBeTruthy());
});
