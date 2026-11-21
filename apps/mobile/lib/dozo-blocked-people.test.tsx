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
  saved: [] as string[],
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => {
    if (store.readFails) throw new Error("locked");
    return store.value;
  }),
  setItemAsync: vi.fn(async (_key: string, value: string) => {
    store.saved.push(value);
    store.value = value;
  }),
}));

const message = (id: string, role: string, author?: string) =>
  ({
    id,
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

async function load() {
  vi.resetModules();
  return import("./dozo-blocked-people");
}

async function renderChat(module: Awaited<ReturnType<typeof load>>) {
  function Chat() {
    shown = module.useWithoutBlocked(chat).map((entry) => entry.id);
    return null;
  }
  await act(async () => root.render(<Chat />));
  await act(() => flush());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store.value = null;
  store.readFails = false;
  store.saved = [];
  shown = [];
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("people blocked on this phone", () => {
  it("shows every message while nobody is blocked", async () => {
    await renderChat(await load());
    expect(shown).toEqual(["1", "2", "3", "4"]);
  });

  it("leaves out the stored people's messages, and only messages people wrote", async () => {
    store.value = JSON.stringify(["user-ada", 7]);
    await renderChat(await load());
    expect(shown).toEqual(["2", "3", "4"]);
  });

  it("hides a person at once when blocked, and keeps them with those already stored", async () => {
    store.value = JSON.stringify(["user-ada"]);
    const module = await load();
    await renderChat(module);
    await act(async () => module.blockPerson("user-bo"));
    await act(() => flush());
    expect(shown).toEqual(["2", "4"]);
    expect(JSON.parse(store.saved.at(-1) ?? "[]")).toEqual(["user-ada", "user-bo"]);
  });

  it("counts an unreadable or malformed list as empty, and still saves a new block", async () => {
    store.readFails = true;
    let module = await load();
    module.blockPerson("user-bo");
    await act(() => flush());
    expect(JSON.parse(store.saved.at(-1) ?? "[]")).toEqual(["user-bo"]);
    store.readFails = false;
    store.value = JSON.stringify({ not: "a list" });
    module = await load();
    await renderChat(module);
    expect(shown).toEqual(["1", "2", "3", "4"]);
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
