// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  routineChat: vi.fn(),
  setRoutineChat: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../../lib/query/rpc", () => {
  const rpc = { dozoChats: { setRoutineChat: api.setRoutineChat } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../../lib/query/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoChats: {
      list: {
        queryOptions: ({ input }: { input: unknown }) => ({
          queryKey: [["dozoChats", "list"], input],
          queryFn: () => api.list(input),
        }),
      },
      routineChat: {
        key: ({ input }: { input: unknown }) => [["dozoChats", "routineChat"], input],
        queryOptions: ({ input }: { input: unknown }) => ({
          queryKey: [["dozoChats", "routineChat"], input],
          queryFn: () => api.routineChat(input),
        }),
      },
    },
  }),
}));
vi.mock("../../../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  OptionSelect: ({
    options,
    value,
    onValueChange,
    size: _size,
    "data-testid": testId,
    ...props
  }: {
    options: { value: string; label: string; disabled?: boolean }[];
    value: string | null;
    onValueChange: (value: string) => void;
    size?: string;
    "data-testid"?: string;
  } & Omit<ComponentProps<"select">, "value" | "onChange" | "size">) => (
    <select
      data-testid={testId}
      {...props}
      value={value ?? ""}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import type * as Query from "../../../lib/query/query";
import { DozoRoutineChat } from "./dozo-routine-chat";

const garden = {
  id: "chat-1",
  botId: "bot-1",
  name: "Garden",
  createdAt: "2026-11-20T10:00:00.000Z",
  archivedAt: null as string | null,
  unread: false,
  snoozedUntil: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api.list.mockResolvedValue({ chats: [garden] });
  api.routineChat.mockResolvedValue({ chatId: null, editable: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <DozoRoutineChat bot={{ id: "bot-1", name: "Chef" }} routineId="routine-1" fieldId="f" />
      </QueryClientProvider>,
    );
  });
}

const select = () => container.querySelector("select");

describe("the chat a routine posts in", () => {
  it("shows nothing for a bot without extra chats", async () => {
    api.list.mockResolvedValue({ chats: [{ ...garden, archivedAt: "2026-11-21T00:00:00.000Z" }] });
    await render();
    await vi.waitFor(() => expect(api.routineChat).toHaveBeenCalled());
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith({ botId: "bot-1" }));
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing for a routine that posts in a group", async () => {
    api.routineChat.mockResolvedValue({ chatId: null, editable: false });
    await render();
    await vi.waitFor(() =>
      expect(api.routineChat).toHaveBeenCalledWith({ routineId: "routine-1" }),
    );
    expect(container.innerHTML).toBe("");
  });

  it("offers the main chat by the bot's name and the open extra chats, and saves a pick at once", async () => {
    await render();
    await vi.waitFor(() => expect(select()).not.toBeNull());
    expect(container.textContent).toContain("Chat");
    expect([...select()!.options].map((option) => [option.value, option.text])).toEqual([
      ["", "Chef"],
      ["chat-1", "Garden"],
    ]);
    expect(select()!.value).toBe("");
    api.setRoutineChat.mockResolvedValue({ chatId: "chat-1", editable: true });
    api.routineChat.mockResolvedValue({ chatId: "chat-1", editable: true });
    await act(async () => {
      select()!.value = "chat-1";
      select()!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(api.setRoutineChat).toHaveBeenCalledWith({ routineId: "routine-1", chatId: "chat-1" }),
    );
    await vi.waitFor(() => expect(select()!.value).toBe("chat-1"));
    api.setRoutineChat.mockResolvedValue({ chatId: null, editable: true });
    await act(async () => {
      select()!.value = "";
      select()!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(api.setRoutineChat).toHaveBeenLastCalledWith({ routineId: "routine-1", chatId: null }),
    );
  });

  it("says a failed save, keeping what the routine posts in", async () => {
    api.setRoutineChat.mockRejectedValue(new Error("Not found"));
    await render();
    await vi.waitFor(() => expect(select()).not.toBeNull());
    await act(async () => {
      select()!.value = "chat-1";
      select()!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => expect(api.toastError).toHaveBeenCalled());
    await vi.waitFor(() => expect(select()!.value).toBe(""));
  });
});
