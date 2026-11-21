import { useLingui } from "@lingui/react/macro";
import type { DozoBotChat } from "@rakazo/contracts";
import type { SnoozePreset } from "@rakazo/core";
import { chatSnoozed, SNOOZE_PRESETS, snoozePresetTime } from "@rakazo/core";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Archive, Bell, BellDot, Check, ChevronDown, Clock, Pencil, Plus } from "lucide-react";
import { useId, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { errorText, toastError } from "../../lib/dozo-error-text";
import {
  dozoChatOf,
  dozoExtraChatOpen,
  dozoOpenChat,
  setDozoOpenChat,
} from "../../lib/dozo-open-chat";
import { queryClient, useSave, useSpaceQueries } from "../../lib/query";
import { rpc as selectedSpaceRpc } from "../../lib/rpc";
import { useEventListener } from "../../lib/use-event-listener";
import { DozoChatExportMenu } from "./dozo-chat-export-menu";

/**
 * A bot's extra chats. The bot's main chat stays `/app/<bot>`; an extra chat is
 * `/app/<bot>?chat=<id>`, so a refresh keeps it and every way into the main chat still lands there.
 * The shell is remounted when the chat changes (`dozo-shell`), so each of its hooks sees one chat
 * from start to end; the requests that act on the open chat take its id from the client the shell
 * makes (`dozoChatRpc`).
 */

/** Reads the open chat from the address; the shell wrapper keys the shell by what it returns. */
export function useDozoOpenChat(): string | undefined {
  const { botId } = useParams();
  const [params] = useSearchParams();
  const chatId = (botId && params.get("chat")) || undefined;
  setDozoOpenChat(botId && chatId ? { botId, chatId } : null);
  return chatId;
}

export { dozoChatOf, dozoExtraChatOpen };

/**
 * The target of a request about this bot's chat on screen: its extra chat as `chatBotId` with
 * `chatId` (never `botId`, which an API from before extra chats would read as the main chat), or
 * its main chat as `botId`.
 */
export function dozoChatTarget(
  botId: string,
): { botId: string } | { chatBotId: string; chatId: string } {
  const chatId = dozoChatOf(botId).chatId;
  return chatId ? { chatBotId: botId, chatId } : { botId };
}

/** The open chat's address in a target of the chat requests, for its cache key. */
export function dozoChatInput<T extends object>(target: T): T {
  const { botId, ...rest } = target as { botId?: unknown };
  return typeof botId === "string" && dozoChatOf(botId).chatId
    ? ({ ...rest, ...dozoChatTarget(botId) } as T)
    : target;
}

/**
 * The chat requests that act on the chat on screen. A request naming the open chat's bot by
 * `botId` is about the open chat and goes as its `chatBotId` and `chatId`; one naming a chat or a
 * group is left as it is. Reads and Mark as
 * Unread from the roster go elsewhere (`use-chat-read` rules, the roster's own client), so a menu
 * on the bot's row still acts on its main chat.
 */
const OPEN_CHAT_REQUESTS: ReadonlySet<string> = new Set([
  "head",
  "get",
  "messages",
  "subscribe",
  "send",
  "sendWithRoutines",
  "react",
  "stop",
  "stopHelper",
  "followUp",
  "answer",
  "clear",
]);

export function dozoChatRpc<T extends object>(client: T): T {
  const chat = dozoOpenChat();
  if (!chat) return client;
  const scope = (input: unknown) => {
    if (!input || typeof input !== "object") return input;
    const { botId, ...rest } = input as {
      botId?: string;
      groupId?: string;
      chatBotId?: string;
      chatId?: string;
    };
    return botId === chat.botId && !rest.groupId && !rest.chatBotId && !rest.chatId
      ? { ...rest, chatBotId: botId, chatId: chat.chatId }
      : input;
  };
  return new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== "threads" || !value) return value;
      return new Proxy(value, {
        get(threads, procedure, threadsReceiver) {
          const call = Reflect.get(threads, procedure, threadsReceiver);
          if (typeof procedure !== "string" || !OPEN_CHAT_REQUESTS.has(procedure)) return call;
          if (typeof call !== "function") return call;
          const send = call as (...args: unknown[]) => unknown;
          return (input: unknown, ...rest: unknown[]) => send(scope(input), ...rest);
        },
      });
    },
  });
}

/** Extra chats the app has listed, by id, so an alert or a hit can open the right one. */
const knownChats = new Map<string, string>();

/** Where a chat of a bot lives: its extra chat's address when the thread is one, else the bot's. */
export function dozoChatPath(botId: string, threadId?: string | null): string {
  return threadId && knownChats.get(threadId) === botId
    ? `/app/${botId}?chat=${encodeURIComponent(threadId)}`
    : `/app/${botId}`;
}

/** True when an alert about this bot's thread is about the chat on screen. */
export function dozoIsOpenChat(botId: string, threadId: string | undefined): boolean {
  const open = dozoChatOf(botId).chatId;
  if (open) return threadId === open;
  return !threadId || !knownChats.has(threadId);
}

/** The Space's extra chats with the caller's read state; read again on the roster signal. */
export function useDozoBotChats(): DozoBotChat[] {
  const queries = useSpaceQueries();
  const list = useQuery(queries.dozoChats.list.queryOptions({ input: {} }));
  const chats = list.data?.chats ?? [];
  for (const chat of chats) knownChats.set(chat.id, chat.botId);
  return chats;
}

/**
 * Where an address that names no open extra chat of its bot goes instead (an unknown, another
 * bot's or Space's, or an archived chat): the bot's main chat, once the chat list has answered.
 */
export function useDozoChatRedirect(chatId: string | undefined): string | null {
  const { botId } = useParams();
  const queries = useSpaceQueries();
  const list = useQuery({
    ...queries.dozoChats.list.queryOptions({ input: {} }),
    enabled: Boolean(chatId),
  });
  if (!botId || !chatId || !list.isSuccess) return null;
  const known = list.data.chats.some(
    (chat) => chat.id === chatId && chat.botId === botId && !chat.archivedAt,
  );
  return known ? null : `/app/${botId}`;
}

/** Reads the chat lists again; the roster signal carries a change to a chat or its read state. */
export function dozoBotChatsChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: ({ queryKey: [path] }) =>
      Array.isArray(path) && path.slice(-2).join(".") === "dozoChats.list",
  });
}

function useListKey() {
  const queries = useSpaceQueries();
  return queries.dozoChats.list.key();
}

/** Creates an extra chat of the bot and opens it. */
function useNewChat(botId: string) {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const listKey = useListKey();
  return useSave({
    // Named by when it began, so it reads apart from the bot's other chats until it is renamed.
    save: (_: undefined, client) =>
      client.dozoChats.create({
        botId,
        name: i18n.date(new Date(), {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      }),
    stale: [listKey],
    onSaved: ({ chat }) => navigate(dozoChatAddress(botId, chat.id)),
    onFailed: (error) => toastError(t`Something went wrong. Try again.`, error),
  });
}

function dozoChatAddress(botId: string, chatId: string) {
  return `/app/${botId}?chat=${encodeURIComponent(chatId)}`;
}

/** New chat asked for from a bot row's menu, which closes before the chat is made. */
const newChatRequests = new EventTarget();

/** New chat at the top of a bot row's menu; the bot's chat rows make the chat and open it. */
export function DozoNewChatItem({ botId, onClose }: { botId: string; onClose: () => void }) {
  const { t } = useLingui();
  return (
    <ContextMenuItem
      onClick={() => {
        onClose();
        newChatRequests.dispatchEvent(new CustomEvent("new-chat", { detail: botId }));
      }}
    >
      <Plus />
      {t`New chat`}
    </ContextMenuItem>
  );
}

/**
 * Next to the chat header's name: the bot's chats and New chat. With an extra chat open it shows
 * that chat's name, so the header says which chat this is.
 */
export function DozoChatSwitcher({ botId, botName }: { botId: string; botName: string }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const chats = useDozoBotChats().filter((chat) => chat.botId === botId && !chat.archivedAt);
  const open = dozoChatOf(botId).chatId;
  const current = chats.find((chat) => chat.id === open);
  const create = useNewChat(botId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="floating"
            data-testid="dozo-chat-switcher"
            aria-label={current ? undefined : t`Chats`}
            className={`app-no-drag h-auto min-w-0 gap-1 py-1.5 ${current ? "ps-3 pe-2" : "px-2"}`}
          />
        }
      >
        {current ? (
          <span className="block max-w-[14rem] truncate text-body font-medium" dir="auto">
            {current.name}
          </span>
        ) : null}
        <ChevronDown strokeWidth={1.7} className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="min-w-[200px]">
        <DropdownMenuItem onClick={() => navigate(`/app/${botId}`)}>
          <span className="truncate" dir="auto">
            {botName}
          </span>
          {open ? null : <Check className="ms-auto" />}
        </DropdownMenuItem>
        {chats.map((chat) => (
          <DropdownMenuItem key={chat.id} onClick={() => navigate(dozoChatAddress(botId, chat.id))}>
            <span className="truncate" dir="auto">
              {chat.name}
            </span>
            {chat.id === open ? <Check className="ms-auto" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={create.pending} onClick={() => create.run(undefined)}>
          <Plus />
          {t`New chat`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The bot's extra chats under its roster row, only when it has some: a bot without any looks as
 * before. Snoozed ones leave the list until they wake, as chats do.
 */
export function DozoBotChatRows({
  botId,
  compact,
  mini,
  open,
}: {
  botId: string;
  compact: boolean;
  /** The collapsed sidebar lists no chats, but its row menu can still make one. */
  mini: boolean;
  open: (path: string) => void;
}) {
  const create = useNewChat(botId);
  useEventListener(newChatRequests, "new-chat", (event) => {
    if ((event as CustomEvent<string>).detail === botId) create.run(undefined);
  });
  const now = Date.now();
  const chats = useDozoBotChats().filter(
    (chat) => chat.botId === botId && !chat.archivedAt && !chatSnoozed(chat, now),
  );
  const current = dozoChatOf(botId).chatId;
  if (mini || chats.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 pt-0.5" data-dozo-bot-chats={botId}>
      {chats.map((chat) => (
        <DozoBotChatRow
          key={chat.id}
          chat={chat}
          selected={chat.id === current}
          compact={compact}
          onOpen={() => open(dozoChatAddress(botId, chat.id))}
        />
      ))}
    </div>
  );
}

function DozoBotChatRow({
  chat,
  selected,
  compact,
  onOpen,
}: {
  chat: DozoBotChat;
  selected: boolean;
  compact: boolean;
  onOpen: () => void;
}) {
  const { t } = useLingui();
  const [renaming, setRenaming] = useState(false);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<button type="button" />}
        data-dozo-bot-chat={chat.id}
        data-roster-unread={chat.unread ? "true" : undefined}
        aria-current={selected ? "page" : undefined}
        onClick={onOpen}
        onContextMenu={(event) => event.currentTarget.focus()}
        data-compact={compact ? "" : undefined}
        className="flex w-full items-center gap-2 text-start"
      >
        <span dir="auto" data-dozo-bot-chat-name className="min-w-0 flex-1 truncate">
          {chat.name}
        </span>
        {chat.unread ? (
          <>
            <span aria-hidden="true" data-roster-unread-dot className="shrink-0" />
            <span className="sr-only">{t` (unread)`}</span>
          </>
        ) : null}
      </ContextMenuTrigger>
      <DozoBotChatMenu chat={chat} selected={selected} onRename={() => setRenaming(true)} />
      {renaming ? <RenameChatDialog chat={chat} onClose={() => setRenaming(false)} /> : null}
    </ContextMenu>
  );
}

type ChatAction =
  | { kind: "read" }
  | { kind: "unread" }
  | { kind: "snooze"; until: string }
  | { kind: "archive" };

function DozoBotChatMenu({
  chat,
  selected,
  onRename,
}: {
  chat: DozoBotChat;
  selected: boolean;
  onRename: () => void;
}) {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const listKey = useListKey();
  const target = { chatBotId: chat.botId, chatId: chat.id };
  const presetLabels: Record<SnoozePreset, string> = {
    hour: t`1 hour`,
    threeHours: t`3 hours`,
    tomorrow: t`Tomorrow`,
    nextWeek: t`Next week`,
  };
  const change = useSave<ChatAction, unknown>({
    save: async (action, client) => {
      if (action.kind === "read") return client.threads.markRead(target);
      if (action.kind === "unread") return client.threads.markUnread(target);
      if (action.kind === "snooze")
        return client.threads.snooze({ ...target, until: action.until });
      return client.dozoChats.archive({ chatId: chat.id, archived: true });
    },
    stale: [listKey],
    onSaved: (_, action) => {
      if (action.kind === "archive" && selected) navigate(`/app/${chat.botId}`);
    },
    onFailed: (error) => toastError(t`Something went wrong. Try again.`, error),
  });
  const now = new Date();
  return (
    <ContextMenuContent aria-label={t`Actions for ${chat.name}`} className="w-[240px]">
      <ContextMenuItem onClick={onRename}>
        <Pencil />
        {t`Rename`}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => change.run({ kind: chat.unread ? "read" : "unread" })}>
        {chat.unread ? <BellDot /> : <Bell />}
        {chat.unread ? t`Mark as Read` : t`Mark as Unread`}
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Clock />
          {t`Snooze`}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-[200px]">
          {SNOOZE_PRESETS.map((preset) => {
            const wake = snoozePresetTime(preset, now);
            return (
              <ContextMenuItem
                key={preset}
                onClick={() => change.run({ kind: "snooze", until: wake.toISOString() })}
              >
                {presetLabels[preset]}
                <span className="ms-auto text-label text-muted-foreground">
                  {i18n.date(wake, { weekday: "short", hour: "numeric", minute: "2-digit" })}
                </span>
              </ContextMenuItem>
            );
          })}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <DozoChatExportMenu
        rpc={selectedSpaceRpc}
        target={target}
        name={chat.name}
        onClose={() => {}}
      />
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => change.run({ kind: "archive" })}>
        <Archive />
        {t`Archive`}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

function RenameChatDialog({ chat, onClose }: { chat: DozoBotChat; onClose: () => void }) {
  const { t } = useLingui();
  const nameId = useId();
  const listKey = useListKey();
  const [name, setName] = useState(chat.name);
  const trimmed = name.trim();
  const rename = useSave({
    save: (value: string, client) => client.dozoChats.rename({ chatId: chat.id, name: value }),
    stale: [listKey],
    onSaved: onClose,
  });
  return (
    <Dialog open onOpenChange={(next) => (next || rename.pending ? undefined : onClose())}>
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed && trimmed !== chat.name) rename.run(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t`Rename`}</DialogTitle>
          </DialogHeader>
          <label htmlFor={nameId} className="block text-body text-foreground/75">
            {t`Name`}
            <Input
              id={nameId}
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-2"
              autoFocus
            />
          </label>
          {rename.error ? (
            <p className="text-body text-destructive">
              {errorText(rename.error, t`Something went wrong. Try again.`)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={rename.pending} onClick={onClose}>
              {t`Cancel`}
            </Button>
            <Button type="submit" disabled={rename.pending || !trimmed || trimmed === chat.name}>
              {rename.pending ? t`Saving…` : t`Save`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
