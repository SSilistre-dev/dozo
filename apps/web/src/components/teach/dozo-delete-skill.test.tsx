// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock("../../lib/rpc", () => {
  const client = { skills: { remove: api.remove, list: vi.fn() }, dozoTeach: { review: vi.fn() } };
  return {
    rpc: client,
    createSpaceRpc: () => client,
    rpcForSpace: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button"> & { variant?: string; size?: string }) => {
    const { variant: _variant, size: _size, ...rest } = props;
    return <button type="button" {...rest} />;
  },
}));
vi.mock("../ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    title: ReactNode;
    error?: ReactNode;
    confirmLabel: ReactNode;
    onConfirm: () => void;
    onCancel: () => void;
    busy?: boolean;
  }) => (
    <div role="alertdialog">
      <h2>{props.title}</h2>
      {props.error ? <p role="alert">{props.error}</p> : null}
      <button type="button" disabled={props.busy} onClick={props.onConfirm}>
        {props.confirmLabel}
      </button>
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  ),
}));

import { DeleteSkill } from "./dozo-delete-skill";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(props: ComponentProps<typeof DeleteSkill>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DeleteSkill {...props} />
      </QueryClientProvider>,
    ),
  );
}

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === text);
const dialog = () => container.querySelector('[role="alertdialog"]');

async function click(node: Element | null | undefined) {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.remove.mockReset();
  api.remove.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("asks first, then deletes the skill and says so", async () => {
  const onDeleted = vi.fn();
  await render({ skillId: "skill-1", name: "Export", onDeleted });
  expect(dialog()).toBeNull();
  await click(button("Delete"));
  expect(dialog()?.querySelector("h2")?.textContent).toBe('Delete "Export"?');
  await click(dialog()?.querySelector("button"));
  await vi.waitFor(() => expect(onDeleted).toHaveBeenCalled());
  expect(api.remove).toHaveBeenCalledWith({ skillId: "skill-1" });
  expect(dialog()).toBeNull();
});

it("is an icon with a name in a list, shows a failure and can be cancelled", async () => {
  await render({ skillId: "skill-1", name: "Export", icon: true });
  const icon = container.querySelector('button[aria-label="Delete"]');
  await click(icon);
  api.remove.mockRejectedValueOnce(new Error("Gone wrong"));
  await click(dialog()?.querySelector("button"));
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Gone wrong"),
  );
  await click(button("Cancel"));
  expect(dialog()).toBeNull();
});
