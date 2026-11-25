import { darkTokens, lightTokens, UI_APPEARANCE_STORAGE_KEY } from "@rakazo/ui-tokens";
import { dozoTheme } from "@rakazo/ui-tokens/dozo-themes";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The anchored rules in apps/mobile/lib/appearance.ts and user-bubble.ts, on the branded tree: the
// phone's own appearance module paints a saved theme, tells its subscribers, and starts plain when
// what was saved no longer fits.

const store = new Map<string, string>();
let colorScheme: "light" | "dark" = "dark";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

vi.mock("react-native", () => ({
  Appearance: {
    getColorScheme: () => colorScheme,
    setColorScheme: () => undefined,
    addChangeListener: () => ({ remove: () => undefined }),
  },
}));

beforeEach(() => {
  store.clear();
  colorScheme = "dark";
  vi.resetModules();
});

describe("the phone's appearance with a saved theme", () => {
  it("paints the theme the next start over its own tone", async () => {
    store.set(UI_APPEARANCE_STORAGE_KEY, "dark");
    store.set("dozo.uiTheme", "yoru");
    const { loadAppearancePreference, mobileTokens } = await import("./appearance/appearance");
    await loadAppearancePreference();
    expect(mobileTokens().background).toBe(dozoTheme("yoru")?.palette.background);
    expect(mobileTokens().destructive).toBe(darkTokens.destructive);
  });

  it("starts plain Light or Dark when the saved theme is gone or beside the other tone", async () => {
    store.set(UI_APPEARANCE_STORAGE_KEY, "light");
    store.set("dozo.uiTheme", "yoru");
    const { loadAppearancePreference, mobileTokens } = await import("./appearance/appearance");
    await loadAppearancePreference();
    expect(mobileTokens()).toEqual(lightTokens);
    store.set("dozo.uiTheme", "neon");
    await loadAppearancePreference();
    expect(mobileTokens()).toEqual(lightTokens);
  });

  it("starts plain when the choice is System, whatever theme was left behind", async () => {
    store.set(UI_APPEARANCE_STORAGE_KEY, "system");
    store.set("dozo.uiTheme", "sumi");
    const { loadAppearancePreference, mobileTokens } = await import("./appearance/appearance");
    await loadAppearancePreference();
    expect(mobileTokens()).toEqual(darkTokens);
  });

  it("tells whoever follows the appearance when the theme changes within one tone", async () => {
    const { subscribeAppearance, mobileTokens } = await import("./appearance/appearance");
    const { setDozoTheme, setDozoBubble } = await import("./dozo-theme-store");
    const listener = vi.fn();
    const stop = subscribeAppearance(listener);
    setDozoTheme("hoji");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mobileTokens("dark").background).toBe(dozoTheme("hoji")?.palette.background);
    setDozoBubble("neutral");
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    setDozoBubble("bot");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the bot's color in the bubble, and drops it when Message color is Neutral", async () => {
    const { withUserBubble } = await import("./messages/user-bubble");
    const { setDozoBubble } = await import("./dozo-theme-store");
    const bot = { background: "#aa3322", foreground: "#ffffff" };
    expect(withUserBubble(darkTokens, bot).chatUser).toBe("#aa3322");
    expect(withUserBubble(darkTokens, undefined)).toBe(darkTokens);
    setDozoBubble("neutral");
    expect(withUserBubble(darkTokens, bot)).toBe(darkTokens);
  });
});
