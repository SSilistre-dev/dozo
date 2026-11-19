// @vitest-environment jsdom
import type { AccessGrant } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ update: vi.fn(), delete: vi.fn(), toastError: vi.fn() }));

vi.mock("../lib/rpc", () => {
  const rpc = { dozoAdmin: { accessGrants: { update: api.update, delete: api.delete } } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({ accessGrants: { list: { key: () => ["grants"] } } }),
}));
vi.mock("../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: ({
      variant: _variant,
      ...props
    }: ComponentProps<"button"> & { variant?: string }) => <button type="button" {...props} />,
    DropdownMenuTrigger: ({ disabled, render }: { disabled?: boolean; render: ReactNode }) => (
      <fieldset disabled={disabled}>{render}</fieldset>
    ),
    Field: Pass,
    FieldLabel: ({ children, htmlFor }: { children: ReactNode; htmlFor: string }) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
  };
});

import type * as Query from "../lib/query";
import { DozoGrantActions } from "./dozo-access-grant-actions";

const pending: AccessGrant = {
  id: "g1",
  email: "ada@example.test",
  creditCents: 2500,
  freeMonths: 0,
  createdBy: null,
  status: "pending",
  createdAt: "2026-11-01T00:00:00.000Z",
  appliedAt: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onRevoke = vi.fn();

async function render(grant: AccessGrant, busy = false) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <DozoGrantActions grant={grant} busy={busy} onRevoke={onRevoke} />
      </QueryClientProvider>,
    );
  });
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);
const field = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`);
const click = async (name: string) => act(async () => button(name)?.click());

async function type(id: string, value: string) {
  const input = field(id);
  if (!input) throw new Error(`Missing ${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [...Object.values(api), onRevoke]) mock.mockReset();
  api.update.mockResolvedValue({ ok: true });
  api.delete.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("offers a pending grant edit, revoke and delete, behind one named menu", async () => {
  await render(pending);
  expect(container.querySelector('[aria-label="Actions for ada@example.test"]')).toBeTruthy();
  expect(button("Edit")).toBeTruthy();
  await click("Revoke");
  expect(onRevoke).toHaveBeenCalled();
  await click("Delete");
  expect(api.delete).toHaveBeenCalledWith({ id: "g1" });
});

it("offers a revoked grant only delete, and a received one nothing", async () => {
  await render({ ...pending, status: "revoked" });
  expect(button("Edit")).toBeUndefined();
  expect(button("Revoke")).toBeUndefined();
  expect(button("Delete")).toBeTruthy();
  await render({ ...pending, status: "applied" });
  expect(container.textContent).toBe("");
});

it("edits a pending grant in a dialog that starts from what it grants", async () => {
  await render(pending);
  await click("Edit");
  expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  expect(field("edit-grant-email")?.value).toBe("ada@example.test");
  expect(field("edit-grant-credits")?.value).toBe("25");
  expect(field("edit-grant-months")?.value).toBe("");
  await type("edit-grant-credits", "");
  // Nothing granted: nothing to save.
  expect(button("Save")?.disabled).toBe(true);
  await type("edit-grant-months", "3");
  await type("edit-grant-email", "bob@example.test");
  await act(async () => container.querySelector("form")?.requestSubmit());
  expect(api.update).toHaveBeenCalledWith({
    id: "g1",
    grant: { email: "bob@example.test", creditCents: 0, freeMonths: 3 },
  });
  await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
});

it("starts the dialog's fields from a grant of months only", async () => {
  await render({ ...pending, creditCents: 0, freeMonths: 2 });
  await click("Edit");
  expect(field("edit-grant-credits")?.value).toBe("");
  expect(field("edit-grant-months")?.value).toBe("2");
});

it("tells a failed save or delete, and holds the menu while the page is saving", async () => {
  api.delete.mockRejectedValue(new Error("nope"));
  await render(pending);
  await click("Delete");
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("Could not delete grant", expect.any(Error)),
  );
  api.update.mockRejectedValue(new Error("nope"));
  await click("Edit");
  await act(async () => container.querySelector("form")?.requestSubmit());
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("Could not save the grant", expect.any(Error)),
  );
  await render(pending, true);
  expect(container.querySelector("fieldset")?.disabled).toBe(true);
});
