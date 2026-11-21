import type { MessageAuthor } from "@rakazo/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { MobileMessage } from "./mobile-types";

/**
 * People this phone hides: their messages in shared chats are not shown (App Review 1.2), and a
 * chat they wrote in shows no preview line in the inbox, since the preview does not say who wrote
 * it. Kept on the device only; the person is not told and stays in the Space.
 */
const KEY = "dozo.blocked-people";

// Loaded on first use, not with this module: the inbox rows import it, and the native storage
// module must not load with them (it needs the app's runtime, which their tests do not start).
const secureStore = () => import("expo-secure-store");

type Blocked = { people: ReadonlySet<string>; chats: ReadonlySet<string> };

let blocked: Blocked = { people: new Set(), chats: new Set() };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

async function read(): Promise<void> {
  let stored: unknown;
  try {
    const raw = await (await secureStore()).getItemAsync(KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    // Secure storage locked or the list unreadable: it counts as empty.
    return;
  }
  if (!stored || typeof stored !== "object") return;
  const { people, chats } = stored as { people?: unknown; chats?: unknown };
  blocked = {
    people: new Set([...blocked.people, ...strings(people)]),
    chats: new Set([...blocked.chats, ...strings(chats)]),
  };
  publish();
}

/** Reads the stored list once; an unreadable one counts as empty. */
function load(): Promise<void> {
  loading ??= read();
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void load();
  return () => {
    listeners.delete(listener);
  };
}

function remember(next: Blocked): void {
  blocked = next;
  publish();
  void save();
}

/** Hides this person's messages from now on, on this phone, and the preview of the chat. */
export function blockPerson(id: string, threadId?: string): void {
  remember({
    people: new Set([...blocked.people, id]),
    chats: threadId ? new Set([...blocked.chats, threadId]) : blocked.chats,
  });
}

async function save(): Promise<void> {
  await load();
  const { people, chats } = blocked;
  try {
    const store = await secureStore();
    await store.setItemAsync(KEY, JSON.stringify({ people: [...people], chats: [...chats] }));
  } catch {
    // Not saved: the person stays hidden until the app restarts.
  }
}

/** Whether a message was written by someone this phone hides. */
export function fromBlockedPerson(
  message: Pick<MobileMessage, "role"> & { author?: MessageAuthor },
  people: ReadonlySet<string>,
): boolean {
  return message.role === "user" && Boolean(message.author && people.has(message.author.id));
}

const useBlocked = () => useSyncExternalStore(subscribe, () => blocked);

/**
 * The messages to show: those of people this phone hides are left out, and a chat found holding
 * one is remembered, so its inbox preview stays hidden too.
 */
export function useWithoutBlocked<T extends MobileMessage>(messages: T[]): T[] {
  const { people, chats } = useBlocked();
  const shown = useMemo(
    () =>
      people.size ? messages.filter((message) => !fromBlockedPerson(message, people)) : messages,
    [messages, people],
  );
  const threadId =
    shown.length < messages.length
      ? messages.find((message) => fromBlockedPerson(message, people))?.threadId
      : undefined;
  useEffect(() => {
    if (threadId && !chats.has(threadId))
      remember({ people: blocked.people, chats: new Set([...blocked.chats, threadId]) });
  }, [threadId, chats]);
  return shown;
}

/** A chat's inbox preview, empty where someone this phone hides has written in it. */
export function useShownPreview(chat: { preview: string; threadId?: string }): string {
  const { chats } = useBlocked();
  return chat.threadId && chats.has(chat.threadId) ? "" : chat.preview;
}
