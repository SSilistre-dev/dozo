// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  revisable: vi.fn(),
  edit: vi.fn(),
  regenerate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/rpc", () => {
  const rpc = { dozoMessages: { edit: api.edit, regenerate: api.regenerate } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoMessages: {
      revisable: {
        key: () => ["revisable"],
        queryOptions: ({ input }: { input: { threadId: string } }) => ({
          queryKey: ["revisable"],
          queryFn: () => api.revisable(input),
        }),
      },
    },
  }),
}));
vi.mock("../../lib/dozo-error-text", () => ({
  errorText: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
  toastError: api.toastError,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    type = "button",
    ...props
  }: ComponentProps<"button"> & { variant?: string }) => (
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
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DropdownMenuItem: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" role="menuitem" {...props}>
      {children}
    </button>
  ),
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

vi.mock("../../components/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    title: ReactNode;
    confirmLabel: ReactNode;
    onConfirm: () => void;
    onCancel: () => void;
  }) => (
    <div role="alertdialog">
      <h2>{props.title}</h2>
      <button type="button" data-dismiss onClick={props.onCancel}>
        Cancel
      </button>
      <button type="button" data-confirm onClick={props.onConfirm}>
        {props.confirmLabel}
      </button>
    </div>
  ),
}));

import type * as Query from "../../lib/query";
import { useDozoMessageRevision } from "./dozo-message-revision";

const ask: ThreadMessage = {
  id: "m-ask",
  threadId: "thread-1",
  seq: 4,
  role: "user",
  blocks: [
    { kind: "text", text: "Plan dinner" },
    { kind: "text", text: "for two" },
  ],
  createdAt: "2026-11-20T10:00:00.000Z",
};
const reply: ThreadMessage = {
  ...ask,
  id: "m-reply",
  seq: 5,
  role: "bot",
  blocks: [{ kind: "text", text: "Pasta." }],
};

function Menu({ message, open }: { message: ThreadMessage; open: boolean }) {
  const revision = useDozoMessageRevision(message, open);
  return (
    <>
      <div data-menu>{revision.items}</div>
      {revision.dialog}
    </>
  );
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(message: ThreadMessage, open = true) {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Menu message={message} open={open} />
      </QueryClientProvider>,
    );
  });
}

const item = (name: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === name);
const click = (node: Element | null | undefined) =>
  act(async () => {
    if (!node) throw new Error("Missing control");
    (node as HTMLElement).click();
  });
const textarea = () => container.querySelector("textarea");
async function type(value: string) {
  await act(async () => {
    const node = textarea();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(node, value);
    node?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = () =>
  act(async () => {
    container.querySelector("form")?.requestSubmit();
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.revisable.mockResolvedValue({ editMessageId: "m-ask", regenerateMessageId: "m-reply" });
  api.edit.mockResolvedValue({ runId: "r-new" });
  api.regenerate.mockResolvedValue({ runId: "r-new" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("asks the server only while the menu is open", async () => {
  await render(ask, false);
  expect(api.revisable).not.toHaveBeenCalled();
  expect(container.querySelector("[role=menuitem]")).toBeNull();
  await render(ask, true);
  await vi.waitFor(() => expect(item("Edit")).toBeTruthy());
  expect(api.revisable).toHaveBeenCalledWith({ threadId: "thread-1" });
});

it("offers Regenerate only on the reply the server names", async () => {
  await render(reply);
  await vi.waitFor(() => expect(item("Regenerate")).toBeTruthy());
  expect(item("Edit")).toBeUndefined();
  await click(item("Regenerate"));
  expect(api.regenerate).toHaveBeenCalledWith({ threadId: "thread-1", messageId: "m-reply" });
});

it("offers nothing on a message the server does not name", async () => {
  api.revisable.mockResolvedValue({ editMessageId: null, regenerateMessageId: null });
  await render(ask);
  await vi.waitFor(() => expect(api.revisable).toHaveBeenCalled());
  expect(container.querySelector("[role=menuitem]")).toBeNull();
});

it("never asks for a message still streaming", async () => {
  await render({ ...reply, id: "progress:r-1" });
  expect(api.revisable).not.toHaveBeenCalled();
});

it("edits the message in a dialog and sends the new text", async () => {
  await render(ask);
  await vi.waitFor(() => expect(item("Edit")).toBeTruthy());
  await click(item("Edit"));
  expect(textarea()?.value).toBe("Plan dinner\n\nfor two");
  await type("   ");
  expect(item("Send")?.hasAttribute("disabled")).toBe(true);
  await submit();
  expect(api.edit).not.toHaveBeenCalled();
  await type(" Plan lunch ");
  await submit();
  await vi.waitFor(() =>
    expect(api.edit).toHaveBeenCalledWith({
      threadId: "thread-1",
      messageId: "m-ask",
      text: "Plan lunch",
    }),
  );
  await vi.waitFor(() => expect(textarea()).toBeNull());
});

it("keeps the dialog with the error when the edit is refused", async () => {
  api.edit.mockRejectedValue(new Error("This message can no longer be changed."));
  await render(ask);
  await vi.waitFor(() => expect(item("Edit")).toBeTruthy());
  await click(item("Edit"));
  await submit();
  await vi.waitFor(() =>
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "This message can no longer be changed.",
    ),
  );
  expect(textarea()).toBeTruthy();
});

it("closes the dialog on Cancel and on the dialog's own close", async () => {
  await render(ask);
  await vi.waitFor(() => expect(item("Edit")).toBeTruthy());
  await click(item("Edit"));
  await click(item("Cancel"));
  expect(textarea()).toBeNull();
  await click(item("Edit"));
  await click(container.querySelector("[data-close]"));
  expect(textarea()).toBeNull();
});

it("says so when a regenerate fails", async () => {
  api.regenerate.mockRejectedValue(new Error("Busy"));
  await render(reply);
  await vi.waitFor(() => expect(item("Regenerate")).toBeTruthy());
  await click(item("Regenerate"));
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Busy"));
});

describe("an earlier message", () => {
  const confirmation = () => container.querySelector("[role=alertdialog]");
  beforeEach(() => {
    api.revisable.mockResolvedValue({
      editMessageId: "m-later",
      regenerateMessageId: "m-later-reply",
      earlierEditMessageIds: ["m-ask"],
      earlierRegenerateMessageIds: ["m-reply"],
      removedCounts: { "m-ask": 3, "m-reply": 1 },
    });
  });

  it("edits, then asks before Send removes the later messages, naming how many", async () => {
    await render(ask);
    await vi.waitFor(() => expect(item("Edit")).toBeTruthy());
    await click(item("Edit"));
    expect(confirmation()).toBeNull();
    expect(textarea()?.value).toBe("Plan dinner\n\nfor two");
    await type("Plan lunch");
    await submit();
    expect(api.edit).not.toHaveBeenCalled();
    expect(confirmation()?.textContent).toContain("Remove 3 messages?");
    expect(container.querySelector("[data-confirm]")?.textContent).toBe("Remove");
    // Cancel keeps the edit open with its text.
    await click(container.querySelector("[data-dismiss]"));
    expect(confirmation()).toBeNull();
    expect(textarea()?.value).toBe("Plan lunch");
    expect(api.edit).not.toHaveBeenCalled();

    await submit();
    await click(container.querySelector("[data-confirm]"));
    await vi.waitFor(() =>
      expect(api.edit).toHaveBeenCalledWith({
        threadId: "thread-1",
        messageId: "m-ask",
        text: "Plan lunch",
      }),
    );
    await vi.waitFor(() => expect(textarea()).toBeNull());
  });

  it("asks before Regenerate and does nothing when cancelled", async () => {
    await render(reply);
    await vi.waitFor(() => expect(item("Regenerate")).toBeTruthy());
    await click(item("Regenerate"));
    expect(confirmation()?.textContent).toContain("Remove 1 message?");
    await click(container.querySelector("[data-dismiss]"));
    expect(api.regenerate).not.toHaveBeenCalled();
    await click(item("Regenerate"));
    expect(container.querySelector("[data-confirm]")?.textContent).toBe("Remove");
    await click(container.querySelector("[data-confirm]"));
    await vi.waitFor(() =>
      expect(api.regenerate).toHaveBeenCalledWith({ threadId: "thread-1", messageId: "m-reply" }),
    );
  });
});
