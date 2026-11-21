import type { MessageAuthor } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging";
import * as SecureStore from "expo-secure-store";
import { useMemo, useSyncExternalStore } from "react";
import type { MobileMessage } from "./mobile-types";

/**
 * People this phone hides: their messages in shared chats are not shown (App Review 1.2). Kept on
 * the device only; the person is not told and stays in the Space.
 */
const KEY = "dozo.blocked-people";

let blocked: ReadonlySet<string> = new Set();
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

async function read(): Promise<void> {
  const raw = await SecureStore.getItemAsync(KEY);
  const ids: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(ids)) return;
  blocked = new Set([...blocked, ...ids.filter((id): id is string => typeof id === "string")]);
  publish();
}

/** Reads the stored list once; an unreadable one counts as empty. */
function load(): Promise<void> {
  loading ??= bestEffort("blocked people: read", read()).then(() => undefined);
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void load();
  return () => {
    listeners.delete(listener);
  };
}

/** Hides this person's messages from now on, on this phone. */
export function blockPerson(id: string): void {
  blocked = new Set([...blocked, id]);
  publish();
  void bestEffort(
    "blocked people: save",
    load().then(() => SecureStore.setItemAsync(KEY, JSON.stringify([...blocked]))),
  );
}

/** Whether a message was written by someone this phone hides. */
export function fromBlockedPerson(
  message: Pick<MobileMessage, "role"> & { author?: MessageAuthor },
  people: ReadonlySet<string>,
): boolean {
  return message.role === "user" && Boolean(message.author && people.has(message.author.id));
}

/** The messages to show: those of people this phone hides are left out. */
export function useWithoutBlocked<T extends MobileMessage>(messages: T[]): T[] {
  const people = useSyncExternalStore(subscribe, () => blocked);
  return useMemo(
    () =>
      people.size ? messages.filter((message) => !fromBlockedPerson(message, people)) : messages,
    [messages, people],
  );
}
