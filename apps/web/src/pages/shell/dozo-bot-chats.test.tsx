// @vitest-environment jsdom
import type { DozoBotChat } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  archive: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  snooze: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/rpc", () => {
  const rpc = {
    dozoChats: { create: api.create, rename: api.rename, archive: api.archive },
    threads: { markRead: api.markRead, markUnread: api.markUnread, snooze: api.snooze },
  };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoChats: {
      list: {
        key: () => [["dozoChats", "list"]],
        queryOptions: ({ input }: { input: unknown }) => ({
          queryKey: [["dozoChats", "list"], input],
          queryFn: () => api.list(input),
        }),
      },
    },
  }),
}));
vi.mock("../../lib/dozo-error-text", () => ({
  errorText: (error: unknown) => (error instanceof Error ? error.message : "failed"),
  toastError: api.toastError,
}));
vi.mock("./dozo-chat-export-menu", () => ({
  DozoChatExportMenu: ({ target }: { target: { chatId?: string } }) => (
    <button type="button" role="menuitem" data-export={target.chatId}>
      Export
    </button>
  ),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { date: (_date: Date, options?: object) => (options ? "Nov 21, 5:41 PM" : "x") },
  }),
}));
vi.mock("@rakazo/ui-web", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _v,
      size: _s,
      ...props
    }: ComponentProps<"button"> & Record<string, string>) => <button type="button" {...props} />,
    ContextMenu: passthrough,
    ContextMenuTrigger: ({
      render: _render,
      children,
      ...props
    }: ComponentProps<"button"> & { render: ReactElement }) => (
      <button type="button" data-trigger {...props}>
        {children}
      </button>
    ),
    ContextMenuContent: ({ children }: { children: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    ContextMenuItem: ({ children, ...props }: ComponentProps<"button">) => (
      <button type="button" role="menuitem" {...props}>
        {children}
      </button>
    ),
    ContextMenuSeparator: () => <hr />,
    ContextMenuSub: passthrough,
    ContextMenuSubTrigger: passthrough,
    ContextMenuSubContent: passthrough,
    Dialog: ({
      children,
      onOpenChange,
    }: {
      children: ReactNode;
      onOpenChange: (o: boolean) => void;
    }) => (
      <div role="dialog">
        <button type="button" data-dismiss onClick={() => onOpenChange(false)} />
        <button type="button" data-reopen onClick={() => onOpenChange(true)} />
        {children}
      </div>
    ),
    DialogContent: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogFooter: passthrough,
    DropdownMenu: passthrough,
    DropdownMenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) => (
      <div data-switcher>
        {render}
        {children}
      </div>
    ),
    DropdownMenuContent: ({ children }: { children: ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    DropdownMenuItem: ({ children, ...props }: ComponentProps<"button">) => (
      <button type="button" role="menuitem" {...props}>
        {children}
      </button>
    ),
    DropdownMenuSeparator: () => <hr />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Spinner: () => <span>loading</span>,
  };
});

import type * as Query from "../../lib/query";
import {
  DozoBotChatRows,
  DozoChatAddress,
  DozoChatSwitcher,
  DozoNewChatItem,
  dozoBotChatsChanged,
  dozoChatInput,
  dozoChatOf,
  dozoChatPath,
  dozoChatRpc,
  dozoChatTarget,
  dozoExtraChatOpen,
  dozoIsOpenChat,
  useDozoChatRedirect,
  useDozoOpenChat,
} from "./dozo-bot-chats";

const chat = (overrides: Partial<DozoBotChat> = {}): DozoBotChat => ({
  id: "chat-1",
  botId: "bot-1",
  name: "Garden",
  createdAt: "2026-11-20T10:00:00.000Z",
  archivedAt: null,
  unread: false,
  snoozedUntil: null,
  ...overrides,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

function Location() {
  const location = useLocation();
  return <output data-location>{`${location.pathname}${location.search}`}</output>;
}

function OpenChat() {
  return <output data-open>{useDozoOpenChat() ?? "main"}</output>;
}

/** Renders at an address of the app, where the open chat is read from. */
async function render(node: ReactNode, at = "/app/bot-1") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter key={at} initialEntries={[at]}>
          <Routes>
            <Route
              path="/app/:botId"
              element={
                <>
                  <OpenChat />
                  {node}
                  <Location />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const location = () => container.querySelector("[data-location]")?.textContent;
const items = () =>
  [...container.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent);
const click = (node: Element | null | undefined) =>
  act(async () => {
    if (!node) throw new Error("Missing control");
    (node as HTMLElement).click();
  });
const item = (name: string) =>
  [...container.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent === name);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const fn of Object.values(api)) fn.mockReset();
  api.list.mockResolvedValue({ chats: [] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the open chat", () => {
  it("is the main chat at a bot's address, and its extra chat with ?chat=", async () => {
    await render(null, "/app/bot-1");
    expect(container.querySelector("[data-open]")?.textContent).toBe("main");
    expect(dozoExtraChatOpen()).toBe(false);
    expect(dozoChatOf("bot-1")).toEqual({});
    await render(null, "/app/bot-1?chat=chat-1");
    expect(container.querySelector("[data-open]")?.textContent).toBe("chat-1");
    expect(dozoExtraChatOpen()).toBe(true);
    expect(dozoExtraChatOpen("bot-1")).toBe(true);
    expect(dozoExtraChatOpen("bot-2")).toBe(false);
    expect(dozoChatOf("bot-1")).toEqual({ chatId: "chat-1" });
    expect(dozoChatOf("bot-2")).toEqual({});
    expect(dozoChatOf(undefined)).toEqual({});
    expect(dozoChatInput({ botId: "bot-1" })).toEqual({ chatBotId: "bot-1", chatId: "chat-1" });
    expect(dozoChatTarget("bot-1")).toEqual({ chatBotId: "bot-1", chatId: "chat-1" });
    expect(dozoChatTarget("bot-2")).toEqual({ botId: "bot-2" });
    expect(dozoChatInput({ groupId: "g" })).toEqual({ groupId: "g" });
    await render(null, "/app/bot-1");
    expect(dozoChatInput({ botId: "bot-1" })).toEqual({ botId: "bot-1" });
  });

  it("names the open chat in the shell's requests about its bot, and nothing else", async () => {
    await render(null, "/app/bot-1?chat=chat-1");
    const send = vi.fn((input: unknown) => input);
    const markUnread = vi.fn((input: unknown) => input);
    const list = vi.fn();
    const scoped = dozoChatRpc({ threads: { send, markUnread, label: "x" }, dozoChats: { list } });
    // The open chat goes as chatBotId and chatId, never as botId: an API that does not know
    // extra chats refuses it instead of writing to the main chat.
    expect(scoped.threads.send({ botId: "bot-1", text: "hi" } as never)).toEqual({
      text: "hi",
      chatBotId: "bot-1",
      chatId: "chat-1",
    });
    expect(scoped.threads.send({ botId: "bot-2" } as never)).toEqual({ botId: "bot-2" });
    expect(scoped.threads.send({ botId: "bot-1", chatId: "other" } as never)).toEqual({
      botId: "bot-1",
      chatId: "other",
    });
    expect(scoped.threads.send({ groupId: "g" } as never)).toEqual({ groupId: "g" });
    expect(scoped.threads.send(undefined as never)).toBeUndefined();
    // A roster read or Mark as Unread is about the row it was asked from.
    expect(scoped.threads.markUnread({ botId: "bot-1" } as never)).toEqual({ botId: "bot-1" });
    expect(scoped.threads.label).toBe("x");
    expect(scoped.dozoChats.list).toBe(list);
    await render(null, "/app/bot-1");
    const plain = { threads: { send } };
    expect(dozoChatRpc(plain)).toBe(plain);
  });
});

describe("the chat lists", () => {
  it("open an alert's or a hit's extra chat once it is known, and the bot's otherwise", async () => {
    api.list.mockResolvedValue({ chats: [chat()] });
    await render(
      <DozoBotChatRows botId="bot-1" compact={false} mini={false} open={vi.fn()} />,
      "/app/bot-1",
    );
    await vi.waitFor(() => expect(container.querySelector("[data-dozo-bot-chat]")).not.toBeNull());
    expect(api.list).toHaveBeenCalledWith({});
    expect(dozoChatPath("bot-1", "chat-1")).toBe("/app/bot-1?chat=chat-1");
    expect(dozoChatPath("bot-1", "main")).toBe("/app/bot-1");
    expect(dozoChatPath("bot-2", "chat-1")).toBe("/app/bot-2");
    expect(dozoChatPath("bot-1")).toBe("/app/bot-1");
    // On the bot's main chat, an alert from its extra chat is not about the chat on screen.
    expect(dozoIsOpenChat("bot-1", "chat-1")).toBe(false);
    expect(dozoIsOpenChat("bot-1", "main")).toBe(true);
    expect(dozoIsOpenChat("bot-1", undefined)).toBe(true);
    await render(null, "/app/bot-1?chat=chat-1");
    expect(dozoIsOpenChat("bot-1", "chat-1")).toBe(true);
    expect(dozoIsOpenChat("bot-1", "main")).toBe(false);
  });

  it("are read again on the roster signal", async () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    await dozoBotChatsChanged(client);
    const { predicate } = spy.mock.calls[0]![0] as unknown as {
      predicate: (query: { queryKey: unknown[] }) => boolean;
    };
    expect(predicate({ queryKey: [["dozoChats", "list"], {}] })).toBe(true);
    expect(predicate({ queryKey: [["dozoMessages", "pins"], {}] })).toBe(false);
    expect(predicate({ queryKey: ["other"] })).toBe(false);
  });
});

describe("the roster's extra chat rows", () => {
  it("show nothing for a bot without extra chats, so its row looks as before", async () => {
    api.list.mockResolvedValue({ chats: [chat({ botId: "bot-2" })] });
    await render(<DozoBotChatRows botId="bot-1" compact={false} mini={false} open={vi.fn()} />);
    await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(container.querySelector("[data-dozo-bot-chats]")).toBeNull();
  });

  it("list the open, awake ones under the bot, marking the open and the unread one", async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    api.list.mockResolvedValue({
      chats: [
        chat(),
        chat({ id: "chat-2", name: "Taxes", unread: true }),
        chat({ id: "chat-3", name: "Old", archivedAt: "2026-11-20T11:00:00.000Z" }),
        chat({ id: "chat-4", name: "Later", snoozedUntil: later }),
      ],
    });
    const open = vi.fn();
    await render(
      <DozoBotChatRows botId="bot-1" compact mini={false} open={open} />,
      "/app/bot-1?chat=chat-1",
    );
    await vi.waitFor(() =>
      expect(container.querySelectorAll("[data-dozo-bot-chat]")).toHaveLength(2),
    );
    const [garden, taxes] = container.querySelectorAll("[data-dozo-bot-chat]");
    expect(garden?.getAttribute("aria-current")).toBe("page");
    expect(garden?.hasAttribute("data-compact")).toBe(true);
    expect(taxes?.getAttribute("aria-current")).toBeNull();
    expect(taxes?.getAttribute("data-roster-unread")).toBe("true");
    expect(taxes?.querySelector("[data-roster-unread-dot]")).not.toBeNull();
    expect(taxes?.textContent).toContain("(unread)");
    await click(taxes);
    expect(open).toHaveBeenCalledWith("/app/bot-1?chat=chat-2");
    garden?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });

  it("mark read and unread, snooze, export and archive the chat from its menu", async () => {
    api.list.mockResolvedValue({ chats: [chat({ unread: true })] });
    api.markRead.mockResolvedValue({});
    api.markUnread.mockResolvedValue({});
    api.snooze.mockResolvedValue({});
    api.archive.mockResolvedValue({ chat: chat() });
    await render(
      <DozoBotChatRows botId="bot-1" compact={false} mini={false} open={vi.fn()} />,
      "/app/bot-1?chat=chat-1",
    );
    await vi.waitFor(() => expect(item("Mark as Read")).toBeDefined());
    for (const name of ["Rename", "Mark as Read", "1 hour", "3 hours", "Tomorrow", "Next week"]) {
      expect(items().some((text) => text?.startsWith(name))).toBe(true);
    }
    expect(items().slice(-2)).toEqual(["Export", "Archive"]);
    expect(container.querySelector("[data-export]")?.getAttribute("data-export")).toBe("chat-1");
    await click(item("Mark as Read"));
    await vi.waitFor(() =>
      expect(api.markRead).toHaveBeenCalledWith({ chatBotId: "bot-1", chatId: "chat-1" }),
    );
    const hour = [...container.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.startsWith("1 hour"),
    );
    await click(hour);
    await vi.waitFor(() => expect(api.snooze).toHaveBeenCalled());
    expect(api.snooze.mock.calls[0]![0]).toMatchObject({ chatBotId: "bot-1", chatId: "chat-1" });
    await click(item("Archive"));
    await vi.waitFor(() =>
      expect(api.archive).toHaveBeenCalledWith({ chatId: "chat-1", archived: true }),
    );
    // The open chat archived: back to the bot's main chat.
    await vi.waitFor(() => expect(location()).toBe("/app/bot-1"));
  });

  it("marks a read chat unread, and says so when a change fails", async () => {
    api.list.mockResolvedValue({ chats: [chat()] });
    api.markUnread.mockRejectedValue(new Error("Nope"));
    await render(<DozoBotChatRows botId="bot-1" compact={false} mini={false} open={vi.fn()} />);
    await vi.waitFor(() => expect(item("Mark as Unread")).toBeDefined());
    await click(item("Mark as Unread"));
    await vi.waitFor(() =>
      expect(api.toastError).toHaveBeenCalledWith(
        "Something went wrong. Try again.",
        expect.any(Error),
      ),
    );
    expect(api.markUnread).toHaveBeenCalledWith({ chatBotId: "bot-1", chatId: "chat-1" });
  });

  it("archives a chat that is not open without leaving the one on screen", async () => {
    api.list.mockResolvedValue({ chats: [chat()] });
    api.archive.mockResolvedValue({ chat: chat() });
    await render(
      <DozoBotChatRows botId="bot-1" compact={false} mini={false} open={vi.fn()} />,
      "/app/bot-1?x=1",
    );
    await vi.waitFor(() => expect(item("Archive")).toBeDefined());
    await click(item("Archive"));
    await vi.waitFor(() => expect(api.archive).toHaveBeenCalled());
    expect(location()).toBe("/app/bot-1?x=1");
  });

  it("renames the chat in a dialog, keeping it until the save answers", async () => {
    api.list.mockResolvedValue({ chats: [chat()] });
    api.rename
      .mockRejectedValueOnce(new Error("Too long"))
      .mockResolvedValue({ chat: chat({ name: "Herbs" }) });
    await render(<DozoBotChatRows botId="bot-1" compact={false} mini={false} open={vi.fn()} />);
    await vi.waitFor(() => expect(item("Rename")).toBeDefined());
    await click(item("Rename"));
    const input = container.querySelector<HTMLInputElement>('[role="dialog"] input');
    expect(input?.value).toBe("Garden");
    const save = () =>
      [...container.querySelectorAll('[role="dialog"] button')].find(
        (node) => node.textContent === "Save",
      ) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "  Herbs ");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save().disabled).toBe(false);
    await act(async () => {
      container
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Too long"));
    expect(api.rename).toHaveBeenCalledWith({ chatId: "chat-1", name: "Herbs" });
    // Reopening asks nothing of the dialog; dismissing it leaves.
    await click(container.querySelector("[data-reopen]"));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await click(save());
    await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull());
    expect(api.rename).toHaveBeenCalledTimes(2);
  });

  it("closes the rename dialog on Cancel or dismiss", async () => {
    api.list.mockResolvedValue({ chats: [chat()] });
    await render(<DozoBotChatRows botId="bot-1" compact={false} mini={false} open={vi.fn()} />);
    await vi.waitFor(() => expect(item("Rename")).toBeDefined());
    await click(item("Rename"));
    const cancel = [...container.querySelectorAll('[role="dialog"] button')].find(
      (node) => node.textContent === "Cancel",
    );
    await click(cancel);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await click(item("Rename"));
    await click(container.querySelector("[data-dismiss]"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // A submit with nothing changed saves nothing.
    await click(item("Rename"));
    await act(async () => {
      container
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(api.rename).not.toHaveBeenCalled();
  });
});

describe("New chat", () => {
  /** The row menu's item, and the bot's chat rows that make the chat (collapsed, they list none). */
  const host = (onClose = vi.fn()) => (
    <>
      <DozoNewChatItem botId="bot-1" onClose={onClose} />
      <DozoBotChatRows botId="bot-1" compact={false} mini open={vi.fn()} />
      <DozoBotChatRows botId="bot-2" compact={false} mini={false} open={vi.fn()} />
    </>
  );

  it("creates a chat of the bot from its row's menu and opens it, after the menu has closed", async () => {
    api.list.mockResolvedValue({ chats: [chat()] });
    api.create.mockResolvedValue({ chat: chat({ id: "chat-9", name: "New chat" }) });
    const onClose = vi.fn();
    await render(host(onClose));
    await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(container.querySelector("[data-dozo-bot-chats]")).toBeNull();
    await click(item("New chat"));
    expect(onClose).toHaveBeenCalled();
    await vi.waitFor(() => expect(location()).toBe("/app/bot-1?chat=chat-9"));
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith({ botId: "bot-1", name: "Nov 21, 5:41 PM" });
  });

  it("says so when the bot holds the most chats", async () => {
    api.create.mockRejectedValue(new Error("A bot holds at most 20 open chats."));
    await render(host());
    await click(item("New chat"));
    await vi.waitFor(() => expect(api.toastError).toHaveBeenCalled());
    expect(location()).toBe("/app/bot-1");
  });
});

describe("the header's chats", () => {
  it("lists the main chat and the bot's open extra chats, ticks the open one, and switches", async () => {
    api.list.mockResolvedValue({
      chats: [
        chat(),
        chat({ id: "chat-2", name: "Taxes", archivedAt: "2026-11-20T11:00:00.000Z" }),
        chat({ id: "chat-3", botId: "bot-2", name: "Elsewhere" }),
      ],
    });
    api.create.mockResolvedValue({ chat: chat({ id: "chat-9" }) });
    await render(<DozoChatSwitcher botId="bot-1" botName="Chef" />, "/app/bot-1?chat=chat-1");
    await vi.waitFor(() => expect(items()).toContain("Garden"));
    expect(items()).toEqual(["Chef", "Garden", "New chat"]);
    expect(container.querySelector('[data-testid="dozo-chat-switcher"]')).not.toBeNull();
    expect(container.querySelector("[data-switcher]")?.textContent).toBe("Garden");
    await click(item("Chef"));
    expect(location()).toBe("/app/bot-1");
  });

  it("on the main chat, names the menu Chats and opens an extra chat or a new one", async () => {
    api.list.mockResolvedValue({ chats: [chat()] });
    api.create.mockResolvedValue({ chat: chat({ id: "chat-9" }) });
    await render(<DozoChatSwitcher botId="bot-1" botName="Chef" />);
    await vi.waitFor(() => expect(items()).toContain("Garden"));
    expect(
      container.querySelector('[data-testid="dozo-chat-switcher"]')?.getAttribute("aria-label"),
    ).toBe("Chats");
    await click(item("Garden"));
    expect(location()).toBe("/app/bot-1?chat=chat-1");
    await click(item("New chat"));
    await vi.waitFor(() => expect(location()).toBe("/app/bot-1?chat=chat-9"));
  });
});

describe("an address naming an extra chat", () => {
  function Redirect() {
    const chatId = useDozoOpenChat();
    const to = useDozoChatRedirect(chatId);
    return <output data-redirect>{to === undefined ? "checking" : (to ?? "stay")}</output>;
  }
  const redirect = () => container.querySelector("[data-redirect]")?.textContent;

  it("stays on one of the bot's open extra chats", async () => {
    api.list.mockResolvedValue({ chats: [chat()] });
    await render(<Redirect />, "/app/bot-1?chat=chat-1");
    await vi.waitFor(() => expect(redirect()).toBe("stay"));
  });

  it("goes to the bot's main chat for an unknown, another bot's or an archived chat", async () => {
    api.list.mockResolvedValue({
      chats: [
        chat({ id: "theirs", botId: "bot-2" }),
        chat({ id: "old", archivedAt: "2026-11-20T11:00:00.000Z" }),
      ],
    });
    for (const id of ["gone", "theirs", "old"]) {
      await render(<Redirect />, `/app/bot-1?chat=${id}`);
      await vi.waitFor(() => expect(redirect()).toBe("/app/bot-1"));
    }
  });

  it("stays when the list cannot be read, as on a server without extra chats", async () => {
    api.list.mockRejectedValue(new Error("No such route"));
    await render(<Redirect />, "/app/bot-1?chat=chat-2");
    await vi.waitFor(() => expect(redirect()).toBe("stay"));
  });

  it("waits for the list, and reads none on a main chat", async () => {
    api.list.mockReturnValue(new Promise(() => undefined));
    await render(<Redirect />, "/app/bot-1?chat=chat-1");
    expect(redirect()).toBe("checking");
    api.list.mockClear();
    await render(<Redirect />, "/app/bot-1");
    expect(redirect()).toBe("stay");
    expect(api.list).not.toHaveBeenCalled();
  });
});

describe("the shell at an extra chat's address", () => {
  /** As the shell wrapper uses it: only an address naming a chat goes through the check. */
  function Address() {
    const chatId = useDozoOpenChat();
    return chatId ? <DozoChatAddress chatId={chatId}>shell</DozoChatAddress> : <p>main</p>;
  }

  it("opens once the chat is known, and sends an unknown one to the bot's main chat", async () => {
    api.list.mockResolvedValue({ chats: [chat()] });
    await render(<Address />, "/app/bot-1?chat=chat-1");
    await vi.waitFor(() => expect(container.textContent).toContain("shell"));
    await render(<Address />, "/app/bot-1?chat=gone");
    await vi.waitFor(() => expect(location()).toBe("/app/bot-1"));
    expect(container.textContent).toContain("main");
  });
});
