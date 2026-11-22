// @vitest-environment jsdom

import { DOZO_THEMES } from "@rakazo/ui-tokens/dozo-themes";
import { afterEach, describe, expect, it } from "vitest";
// public/dozo-boot.js runs as a plain script before first paint, after theme.js set data-theme.
import script from "../../public/dozo-boot.js?raw";

function boot(tone: "dark" | "light", saved: Record<string, string> = {}) {
  const root = document.documentElement;
  root.dataset.theme = tone;
  for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
  new Function(script)();
  (window as { dozoBootStarted?: () => void }).dozoBootStarted?.();
  return { skin: root.dataset.skin, bubble: root.dataset.bubble };
}

afterEach(() => {
  localStorage.clear();
  const root = document.documentElement;
  delete root.dataset.skin;
  delete root.dataset.bubble;
  delete root.dataset.theme;
});

describe("boot theme", () => {
  it("leaves the page as it was with nothing chosen", () => {
    expect(boot("dark")).toEqual({ skin: undefined, bubble: undefined });
    expect(boot("light")).toEqual({ skin: undefined, bubble: undefined });
  });

  it.each(DOZO_THEMES.map((theme) => [theme.id, theme.tone] as const))(
    "applies %s before first paint beside its own tone only",
    (id, tone) => {
      expect(boot(tone, { "dozo.uiTheme": id }).skin).toBe(id);
      localStorage.clear();
      delete document.documentElement.dataset.skin;
      expect(
        boot(tone === "dark" ? "light" : "dark", { "dozo.uiTheme": id }).skin,
      ).toBeUndefined();
    },
  );

  it("knows exactly the themes of the token package", () => {
    const tones = script.match(/const TONES = (\{[^}]*\})/)?.[1] ?? "";
    expect(new Function(`return ${tones}`)()).toEqual(
      Object.fromEntries(DOZO_THEMES.map((theme) => [theme.id, theme.tone])),
    );
  });

  it("falls back to plain Light or Dark for an unknown or older name", () => {
    expect(boot("dark", { "dozo.uiTheme": "neon" }).skin).toBeUndefined();
    expect(boot("dark", { "dozo.uiTheme": "toString" }).skin).toBeUndefined();
  });

  it("applies the neutral message colour, and only that value", () => {
    expect(boot("dark", { "dozo.uiBubble": "neutral" }).bubble).toBe("neutral");
    localStorage.clear();
    delete document.documentElement.dataset.bubble;
    expect(boot("dark", { "dozo.uiBubble": "pink" }).bubble).toBeUndefined();
  });

  it("keeps the page usable when storage is blocked", () => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(boot("dark")).toEqual({ skin: undefined, bubble: undefined });
    } finally {
      Storage.prototype.getItem = getItem;
    }
  });
});
