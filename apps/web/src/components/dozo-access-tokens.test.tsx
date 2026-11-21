// @vitest-environment jsdom
import type { DozoAccessToken } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  bots: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  toastError: vi.fn(),
  copy: vi.fn(),
  confirmed: vi.fn(),
  copied: false,
}));

vi.mock("../lib/rpc", () => {
  const rpc = { dozoAccessTokens: { create: api.create, revoke: api.revoke } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoAccessTokens: {
      list: {
        key: () => ["access-tokens"],
        queryOptions: () => ({ queryKey: ["access-tokens"], queryFn: () => api.list() }),
      },
    },
    bots: {
      list: { queryOptions: () => ({ queryKey: ["bots"], queryFn: () => api.bots() }) },
    },
  }),
}));
vi.mock("./ConfirmIdentityDialog", () => ({
  useIdentityConfirmation: () => ({
    withIdentityConfirmation: <T,>(action: () => Promise<T>) => {
      api.confirmed();
      return action();
    },
    identityDialog: null,
  }),
}));
vi.mock("../lib/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
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
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: ({ children, ...props }: ComponentProps<"select">) => (
    <select {...props}>{children}</select>
  ),
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  toast: { error: api.toastError },
  useCopyText: () => [api.copied, api.copy],
}));

import type * as Query from "../lib/query";
import { queryClient } from "../lib/query";
import { DozoAccessTokensRow } from "./dozo-access-tokens";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const tokens: DozoAccessToken[] = [
  {
    id: "token-1",
    name: "CI",
    botId: "bot-1",
    botName: "Chef",
    hint: "abcd",
    createdAt: "2026-11-20T10:00:00.000Z",
    lastUsedAt: "2026-11-21T10:00:00.000Z",
    expiresAt: "2027-02-18T10:00:00.000Z",
  },
  {
    id: "token-2",
    name: "Laptop",
    botId: null,
    botName: null,
    hint: "wxyz",
    createdAt: "2026-11-19T10:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  },
];

const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label,
  );
const click = (label: string) => act(async () => button(label)?.click());

/** Sets a controlled field's value as typing does, so React sees the change. */
function type(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

async function open() {
  await act(async () => root.render(<DozoAccessTokensRow />));
  expect(api.list).not.toHaveBeenCalled();
  await click("Manage");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) if (typeof mock === "function") mock.mockReset();
  api.copied = false;
  queryClient.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("reads nothing until opened, then lists each token by name, end, bot and last use", async () => {
  api.list.mockResolvedValue(tokens);
  await open();
  await vi.waitFor(() => expect(container.textContent).toContain("Laptop"));
  const rows = [...container.querySelectorAll('[data-testid="dozo-access-token"]')].map(
    (row) => row.textContent,
  );
  expect(rows[0]).toContain("CI");
  expect(rows[0]).toContain("…abcd");
  expect(rows[0]).toContain("Chef");
  expect(rows[0]).toContain("Last used");
  expect(rows[0]).toContain("Expires");
  expect(rows[1]).not.toContain("Expires");
  expect(rows[1]).toContain("…wxyz");
  expect(rows[1]).toContain("Never used");
  expect(container.textContent).not.toContain("dozo_pat_");
});

it("revokes a token and reads the list again", async () => {
  api.list.mockResolvedValue(tokens);
  api.revoke.mockImplementation(async () => {
    api.list.mockResolvedValue(tokens.slice(1));
    return { ok: true };
  });
  await open();
  await vi.waitFor(() => expect(button("Revoke CI")).toBeDefined());
  await click("Revoke CI");
  expect(api.revoke).toHaveBeenCalledWith({ id: "token-1" });
  await vi.waitFor(() => expect(button("Revoke CI")).toBeUndefined());
  expect(button("Revoke Laptop")).toBeDefined();
});

it("says so when revoking fails", async () => {
  api.list.mockResolvedValue(tokens);
  api.revoke.mockRejectedValue(new Error("down"));
  await open();
  await vi.waitFor(() => expect(button("Revoke CI")).toBeDefined());
  await click("Revoke CI");
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Could not revoke token"));
});

it("makes a token for one bot and shows it once", async () => {
  api.list.mockResolvedValue([]);
  api.bots.mockResolvedValue([{ id: "bot-1", name: "Chef" }]);
  api.create.mockResolvedValue({ token: "dozo_pat_secret", accessToken: tokens[0] });
  await open();
  await click("New token");
  expect((button("Create") as HTMLButtonElement).disabled).toBe(true);
  await vi.waitFor(() => expect(container.querySelector("option[value='bot-1']")).not.toBeNull());
  await act(async () => {
    type(container.querySelector("input")!, " CI ");
    type(container.querySelector("select")!, "bot-1");
  });
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(api.create).toHaveBeenCalledWith({ name: "CI", botId: "bot-1", expiresInDays: 90 });
  // Making a token goes through the identity check first.
  expect(api.confirmed).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="dozo-new-token"]')?.textContent).toBe(
      "dozo_pat_secret",
    ),
  );
  await click("Copy token");
  expect(api.copy).toHaveBeenCalledWith("dozo_pat_secret");
  await click("Done");
  expect(container.textContent).not.toContain("dozo_pat_secret");
  expect(button("New token")).toBeDefined();
});

it("makes a token for every bot, and goes back on Cancel", async () => {
  api.list.mockResolvedValue([]);
  api.bots.mockResolvedValue([]);
  api.create.mockRejectedValue(new Error("limit"));
  await open();
  await click("New token");
  await act(async () => {
    type(container.querySelector("input")!, "Laptop");
    type(container.querySelectorAll("select")[1]!, "never");
  });
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(api.create).toHaveBeenCalledWith({ name: "Laptop", expiresInDays: null });
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Could not create token"));
  await click("Cancel");
  expect(container.querySelector("form")).toBeNull();
  expect(button("New token")).toBeDefined();
});

it("names the copied state", async () => {
  api.copied = true;
  api.list.mockResolvedValue([]);
  api.bots.mockResolvedValue([]);
  api.create.mockResolvedValue({ token: "dozo_pat_secret", accessToken: tokens[1] });
  await open();
  await click("New token");
  await act(async () => type(container.querySelector("input")!, "Laptop"));
  await act(async () => container.querySelector("form")!.requestSubmit());
  await vi.waitFor(() => expect(button("Copied")).toBeDefined());
});

it("sends nothing for a name of spaces", async () => {
  api.list.mockResolvedValue([]);
  api.bots.mockResolvedValue([]);
  await open();
  await click("New token");
  await act(async () => type(container.querySelector("input")!, "   "));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(api.create).not.toHaveBeenCalled();
});
