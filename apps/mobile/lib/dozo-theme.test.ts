import { darkTokens, lightTokens } from "@rakazo/ui-tokens";
import { DOZO_THEMES, dozoTheme } from "@rakazo/ui-tokens/dozo-themes";
import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
let unavailable = false;

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => {
    if (unavailable) throw new Error("locked");
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (unavailable) throw new Error("locked");
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    if (unavailable) throw new Error("locked");
    store.delete(key);
  }),
}));

const load = async () => ({
  ...(await import("./dozo-theme")),
  ...(await import("./dozo-theme-store")),
});
beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  unavailable = false;
  vi.resetModules();
});

describe("the phone's named theme", () => {
  it("is plain Light and Dark until one is picked", async () => {
    const { tokensForAppearance, getDozoTheme, getDozoBubble } = await load();
    expect(getDozoTheme()).toBeUndefined();
    expect(getDozoBubble()).toBe("bot");
    expect(tokensForAppearance("dark")).toEqual(darkTokens);
    expect(tokensForAppearance("light")).toEqual(lightTokens);
  });

  it("paints a theme over its own tone only, and stores it under the web's key", async () => {
    const { setDozoTheme, tokensForAppearance } = await load();
    const sumi = dozoTheme("sumi");
    setDozoTheme("sumi");
    expect(tokensForAppearance("dark").background).toBe(sumi?.palette.background);
    expect(tokensForAppearance("light")).toEqual(lightTokens);
    await vi.waitUntil(() => store.get("dozo.uiTheme") === "sumi");
  });

  it("makes the theme's tokens once", async () => {
    const { setDozoTheme, tokensForAppearance } = await load();
    setDozoTheme("yoru");
    expect(tokensForAppearance("dark")).toBe(tokensForAppearance("dark"));
  });

  it("forgets the theme when plain Light or Dark is picked, and stores nothing for it", async () => {
    const { setDozoTheme, tokensForAppearance } = await load();
    setDozoTheme("hoji");
    setDozoTheme(null);
    expect(tokensForAppearance("dark")).toEqual(darkTokens);
    // The writes go in the order they were made: the removal is last, so nothing is left.
    await vi.waitFor(() =>
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("dozo.uiTheme"),
    );
    expect(store.has("dozo.uiTheme")).toBe(false);
  });

  it("ignores a name that is no theme", async () => {
    const { setDozoTheme, getDozoTheme } = await load();
    setDozoTheme("neon");
    expect(getDozoTheme()).toBeUndefined();
  });

  it("tells subscribers when the theme or the message color changes, and not after they leave", async () => {
    const { setDozoTheme, setDozoBubble, subscribeDozoTheme, dozoThemeKey } = await load();
    const listener = vi.fn();
    const stop = subscribeDozoTheme(listener);
    const before = dozoThemeKey();
    setDozoTheme("sumi");
    setDozoBubble("neutral");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(dozoThemeKey()).not.toBe(before);
    stop();
    setDozoBubble("bot");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it.each(DOZO_THEMES)("comes back at the next start for $label beside its tone", async (theme) => {
    store.set("dozo.uiTheme", theme.id);
    const { loadDozoTheme, getDozoTheme } = await load();
    await loadDozoTheme(theme.tone);
    expect(getDozoTheme()?.id).toBe(theme.id);
  });

  it("falls back to plain Light and Dark for a stored name that is gone or beside the wrong tone", async () => {
    const { loadDozoTheme, getDozoTheme } = await load();
    store.set("dozo.uiTheme", "neon");
    await loadDozoTheme("dark");
    expect(getDozoTheme()).toBeUndefined();
    store.set("dozo.uiTheme", "sumi");
    await loadDozoTheme("light");
    expect(getDozoTheme()).toBeUndefined();
    await loadDozoTheme("system");
    expect(getDozoTheme()).toBeUndefined();
  });

  it("reads the message color, and only Neutral is stored", async () => {
    store.set("dozo.uiBubble", "neutral");
    const { loadDozoTheme, getDozoBubble, setDozoBubble } = await load();
    await loadDozoTheme("dark");
    expect(getDozoBubble()).toBe("neutral");
    setDozoBubble("bot");
    await vi.waitFor(() =>
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("dozo.uiBubble"),
    );
    store.set("dozo.uiBubble", "anything");
    await loadDozoTheme("dark");
    expect(getDozoBubble()).toBe("bot");
  });

  it("tells subscribers at start only when what was saved is not what is shown", async () => {
    const { loadDozoTheme, subscribeDozoTheme } = await load();
    const listener = vi.fn();
    subscribeDozoTheme(listener);
    await loadDozoTheme("dark");
    expect(listener).not.toHaveBeenCalled();
    store.set("dozo.uiTheme", "yoru");
    await loadDozoTheme("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    await loadDozoTheme("dark");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the choice in memory when the store cannot be read or written", async () => {
    const { loadDozoTheme, setDozoTheme, getDozoTheme } = await load();
    unavailable = true;
    await loadDozoTheme("dark");
    expect(getDozoTheme()).toBeUndefined();
    setDozoTheme("sumi");
    expect(getDozoTheme()?.id).toBe("sumi");
  });
});

describe("your own bubble", () => {
  const bot = { background: "#aa3322", foreground: "#ffffff" };

  it("wears the bot's color, and the palette's own where the chat has none", async () => {
    const { dozoUserBubble } = await load();
    expect(dozoUserBubble(darkTokens, bot)).toMatchObject({
      chatUser: bot.background,
      chatUserForeground: bot.foreground,
    });
    expect(dozoUserBubble(darkTokens, undefined)).toBe(darkTokens);
  });

  it("with Neutral ignores the bot's color: the plain palette's, the theme's, or the ink in a light theme", async () => {
    const { dozoUserBubble, setDozoBubble, setDozoTheme, tokensForAppearance } = await load();
    setDozoBubble("neutral");
    expect(dozoUserBubble(darkTokens, bot)).toBe(darkTokens);
    setDozoTheme("sumi");
    const dark = tokensForAppearance("dark");
    expect(dozoUserBubble(dark, bot)).toBe(dark);
    setDozoTheme("washi");
    const washi = dozoTheme("washi");
    expect(dozoUserBubble(tokensForAppearance("light"), bot)).toMatchObject({
      chatUser: washi?.palette.foreground,
      chatUserForeground: washi?.palette.background,
    });
  });
});
