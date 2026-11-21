// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileMessage } from "./mobile-types";

const store = vi.hoisted(() => ({
  value: null as string | null,
  readFails: false,
  saveFails: false,
  saved: [] as string[],
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => {
    if (store.readFails) throw new Error("locked");
    return store.value;
  }),
  setItemAsync: vi.fn(async (_key: string, value: string) => {
    if (store.saveFails) throw new Error("locked");
    store.saved.push(value);
    store.value = value;
  }),
}));

const message = (id: string, role: string, author?: string) =>
  ({
    id,
    threadId: "thread-1",
    role,
    blocks: [],
    ...(author ? { author: { id: author, name: author } } : {}),
  }) as unknown as MobileMessage;

const chat = [
  message("1", "user", "user-ada"),
  message("2", "bot"),
  message("3", "user", "user-bo"),
  message("4", "user"),
];

let root: Root;
let shown: string[] = [];
let previews: string[] = [];
const saved = () => JSON.parse(store.saved.at(-1) ?? "null");

async function load() {
  vi.resetModules();
  return import("./dozo-blocked-people");
}

async function renderChat(module: Awaited<ReturnType<typeof load>>) {
  function Chat() {
    shown = module.useWithoutBlocked(chat).map((entry) => entry.id);
    return null;
  }
  function Inbox() {
    previews = [
      module.useShownPreview({ preview: "Ada: hi", threadId: "thread-1" }),
      module.useShownPreview({ preview: "Bot: done", threadId: "thread-2" }),
      module.useShownPreview({ preview: "Another Space" }),
    ];
    return null;
  }
  await act(async () =>
    root.render(
      <>
        <Chat />
        <Inbox />
      </>,
    ),
  );
  await act(() => flush());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store.value = null;
  store.readFails = false;
  store.saveFails = false;
  store.saved = [];
  shown = [];
  previews = [];
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("people blocked on this phone", () => {
  it("shows every message and preview while nobody is blocked", async () => {
    await renderChat(await load());
    expect(shown).toEqual(["1", "2", "3", "4"]);
    expect(previews).toEqual(["Ada: hi", "Bot: done", "Another Space"]);
  });

  it("leaves out the stored people's messages, and remembers the chat that held one", async () => {
    store.value = JSON.stringify({ people: ["user-ada", 7], chats: [] });
    await renderChat(await load());
    expect(shown).toEqual(["2", "3", "4"]);
    expect(previews).toEqual(["", "Bot: done", "Another Space"]);
    expect(saved()).toEqual({ people: ["user-ada"], chats: ["thread-1"] });
  });

  it("hides a person at once when blocked, and keeps them with those already stored", async () => {
    store.value = JSON.stringify({ people: ["user-ada"], chats: ["thread-1"] });
    const module = await load();
    await renderChat(module);
    await act(async () => module.blockPerson("user-bo", "thread-2"));
    await act(() => flush());
    expect(shown).toEqual(["2", "4"]);
    expect(previews).toEqual(["", "", "Another Space"]);
    expect(saved()).toEqual({ people: ["user-ada", "user-bo"], chats: ["thread-1", "thread-2"] });
  });

  it("counts an unreadable or malformed list as empty, and still saves a new block", async () => {
    store.readFails = true;
    let module = await load();
    module.blockPerson("user-bo");
    await act(() => flush());
    expect(saved()).toEqual({ people: ["user-bo"], chats: [] });
    store.readFails = false;
    store.value = JSON.stringify("not a list");
    module = await load();
    await renderChat(module);
    expect(shown).toEqual(["1", "2", "3", "4"]);
  });

  it("keeps a person hidden for now when the list cannot be saved", async () => {
    store.saveFails = true;
    const module = await load();
    await renderChat(module);
    await act(async () => module.blockPerson("user-ada"));
    await act(() => flush());
    expect(shown).toEqual(["2", "3", "4"]);
    expect(store.saved).toEqual([]);
  });

  it("knows who wrote a message", async () => {
    const { fromBlockedPerson } = await load();
    const people = new Set(["user-ada"]);
    expect(fromBlockedPerson(chat[0]!, people)).toBe(true);
    expect(fromBlockedPerson(chat[2]!, people)).toBe(false);
    expect(
      fromBlockedPerson({ role: "bot", author: { id: "user-ada", name: "Ada" } }, people),
    ).toBe(false);
  });
});
