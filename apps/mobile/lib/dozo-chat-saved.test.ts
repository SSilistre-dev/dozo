import { beforeEach, expect, it, vi } from "vitest";
import { composerDraftScope, readComposerDraft, writeComposerDraft } from "./composer/composer-draft";
import type { MobileSnapshot } from "./api/mobile-types";
import type { SavedChatsScope } from "./inbox/saved-chats";
import { readSavedThread, writeSavedThread } from "./inbox/saved-chats";
import { mobileSearchDestination } from "./search/search-destination";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("./api/api-server", () => ({}));
vi.mock("./auth/api-auth", () => ({}));
vi.mock("./api/api-live", () => ({}));
vi.mock("./api/api", () => ({
  currentApiBase: () => "https://api.example.test",
  selectedSpaceId: () => "space-a",
}));
vi.mock("./artifacts/artifact-cache-session", () => ({ artifactCacheSession: async () => "ns-1" }));
vi.mock("./integrations-cache", () => ({
  isIntegrationsScopeCurrent: () => true,
  integrationsCacheScope: async () => null,
}));
vi.mock("./api/session", () => ({
  currentSessionGeneration: () => 1,
  loadSessionToken: async () => "fake-token",
  loadVerifiedIntegrationsScope: async () => null,
  saveVerifiedIntegrationsScope: vi.fn(),
}));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get name() {
      return this.uri.split("/").pop()!;
    }
    get exists() {
      return [...files.keys()].some((path) => path.startsWith(`${this.uri}/`));
    }
    create() {}
    delete() {
      for (const path of [...files.keys()]) if (path.startsWith(`${this.uri}/`)) files.delete(path);
    }
    list() {
      const names = new Set(
        [...files.keys()]
          .filter((path) => path.startsWith(`${this.uri}/`))
          .map((path) => path.slice(this.uri.length + 1).split("/")[0]!),
      );
      return [...names].map((name) =>
        files.has(`${this.uri}/${name}`) ? new File(this, name) : new Directory(this, name),
      );
    }
    copySync() {}
  }
  class File extends Directory {
    override get exists() {
      return files.has(this.uri);
    }
    get size() {
      return (files.get(this.uri) ?? "").length;
    }
    get lastModified() {
      return 0;
    }
    textSync() {
      return files.get(this.uri);
    }
    writeSync(value: string) {
      files.set(this.uri, value);
    }
    moveSync(destination: File) {
      files.set(destination.uri, files.get(this.uri)!);
      files.delete(this.uri);
    }
    override create() {
      files.set(this.uri, files.get(this.uri) ?? "");
    }
    override delete() {
      files.delete(this.uri);
    }
  }
  return { Directory, File, Paths: { cache: "cache", document: "document" } };
});

const scope: SavedChatsScope = {
  apiBase: "https://api.example.test",
  userId: "user-a",
  spaceId: "space-a",
  sessionGeneration: 1,
  selectionId: "space-a",
  namespace: "ns-1",
};
const snapshot = (threadId: string): MobileSnapshot =>
  ({
    botId: "bot-a",
    threadId,
    cursor: 3,
    olderCursor: null,
    run: null,
    messages: [{ id: `${threadId}-m`, role: "user", blocks: [{ kind: "text", text: "hi" }] }],
  }) as unknown as MobileSnapshot;

beforeEach(() => files.clear());

// A bot's chats share the bot in their snapshots, so what tells them apart is the thread.
it("keeps an extra chat's saved copy apart from its bot's main chat's", () => {
  writeSavedThread(scope, "bot:bot-a", snapshot("thread-main"));
  writeSavedThread(scope, "chat:chat-1", snapshot("chat-1"));
  expect(readSavedThread(scope, "bot:bot-a")?.threadId).toBe("thread-main");
  expect(readSavedThread(scope, "chat:chat-1")?.threadId).toBe("chat-1");
  expect(readSavedThread(scope, "chat:chat-2")).toBeNull();
});

it("saves and reads only the thread a chat's file names", () => {
  // The main chat's snapshot never lands in an extra chat's file.
  writeSavedThread(scope, "chat:chat-1", snapshot("thread-main"));
  expect(readSavedThread(scope, "chat:chat-1")).toBeNull();
  expect(files.size).toBe(0);
});

it("keeps each chat's draft under its own key, the web's", () => {
  const main = composerDraftScope("user-a", "bot-1", undefined);
  const chat = composerDraftScope("user-a", "bot-1", undefined, "chat-1");
  const group = composerDraftScope("user-a", undefined, "group-1");
  expect(main?.threadKey).toBe("bot:bot-1");
  expect(chat?.threadKey).toBe("bot:bot-1:chat:chat-1");
  expect(group?.threadKey).toBe("group:group-1");
  writeComposerDraft(main!, "main text", []);
  writeComposerDraft(chat!, "chat text", []);
  expect(readComposerDraft(main).text).toBe("main text");
  expect(readComposerDraft(chat).text).toBe("chat text");
});

it("opens a search hit in an extra chat there, not in the bot's main chat", () => {
  const hit = {
    kind: "message",
    botId: "bot-1",
    botName: "Ada",
    title: "Ada",
    messageId: "message-1",
  } as never;
  expect(mobileSearchDestination(hit)).toEqual({
    pathname: "/thread",
    params: { botId: "bot-1", name: "Ada", messageId: "message-1" },
  });
  expect(mobileSearchDestination({ ...(hit as object), chatId: "chat-1" } as never)).toEqual({
    pathname: "/thread",
    params: { botId: "bot-1", chatId: "chat-1", name: "Ada", messageId: "message-1" },
  });
});
