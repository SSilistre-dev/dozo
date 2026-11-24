import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DOZO_THEMES,
  dozoNeutralBubbleTokens,
  dozoTheme,
  dozoThemeTokens,
  renderDozoThemesCss,
} from "./dozo-themes.js";
import { cssVariableName, darkTokens, lightTokens } from "./index.js";

const css = readFileSync(new URL("../../ui-web/src/dozo-themes.css", import.meta.url), "utf8");

describe("named themes", () => {
  it("are the stylesheet the app loads before its first paint", () => {
    // To refresh it: print renderDozoThemesCss() into packages/ui-web/src/dozo-themes.css.
    expect(css).toBe(renderDozoThemesCss());
  });

  it("are the six of the approved mockup, three dark and three light", () => {
    expect(DOZO_THEMES.map((theme) => `${theme.label}:${theme.tone}`)).toEqual([
      "Sumi:dark",
      "Yoru:dark",
      "Hoji:dark",
      "Washi:light",
      "Matcha:light",
      "Kasumi:light",
    ]);
  });

  it("paint only neutral surfaces and ink: the main button stays ink, status and bot colours stay", () => {
    const painted = [...css.matchAll(/^\s+(--[\w-]+):/gm)].map((match) => match[1]);
    for (const token of [
      "destructive",
      "success",
      "warning",
      "link",
      "unread",
      "border",
    ] as const) {
      expect(painted).not.toContain(cssVariableName(token));
    }
    expect(css).toContain(`${cssVariableName("primary")}: var(--dozo-theme-foreground);`);
  });

  it("apply only beside their own tone, so a stale name under the other tone changes nothing", () => {
    for (const theme of DOZO_THEMES) {
      const block = css
        .split("\n")
        .find((line) => line.includes(`[data-skin="${theme.id}"]`) && line.includes(":is("));
      expect(block).toContain(`html[data-theme="${theme.tone}"]`);
    }
  });

  it("finds a theme by its id, and nothing for an unknown or missing one", () => {
    expect(dozoTheme("yoru")?.tone).toBe("dark");
    expect(dozoTheme("neon")).toBeUndefined();
    expect(dozoTheme(null)).toBeUndefined();
  });
});

describe("a theme on the phone", () => {
  const sumi = dozoTheme("sumi") as NonNullable<ReturnType<typeof dozoTheme>>;
  const washi = dozoTheme("washi") as NonNullable<ReturnType<typeof dozoTheme>>;

  it("paints every token the stylesheet paints from the same palette entry", () => {
    const tokens = dozoThemeTokens(darkTokens, sumi);
    const { palette } = sumi;
    expect(tokens.background).toBe(palette.background);
    expect(tokens.primaryForeground).toBe(palette.background);
    expect(tokens.card).toBe(palette.card);
    expect(tokens.muted).toBe(palette.card);
    expect(tokens.popover).toBe(palette.popover);
    expect(tokens.chatUser).toBe(palette.popover);
    expect(tokens.primary).toBe(palette.foreground);
    expect(tokens.sidebar).toBe(palette.sidebar);
    expect(tokens.mutedForeground).toBe(palette.mutedForeground);
    expect(tokens.faintForeground).toBe(palette.faintForeground);
  });

  it("paints the dialog as the card in dark and the popover in light", () => {
    expect(dozoThemeTokens(darkTokens, sumi).dialog).toBe(sumi.palette.card);
    expect(dozoThemeTokens(lightTokens, washi).dialog).toBe(washi.palette.popover);
  });

  it("leaves status and link colours, borders and tokens the base lacks alone", () => {
    const tokens = dozoThemeTokens(darkTokens, sumi);
    for (const token of [
      "destructive",
      "link",
      "success",
      "warning",
      "border",
      "unread",
    ] as const) {
      expect(tokens[token]).toBe(darkTokens[token]);
    }
    expect(Object.keys(tokens).sort()).toEqual(Object.keys(darkTokens).sort());
  });

  it("does not change the palette it is given", () => {
    const before = { ...lightTokens };
    dozoThemeTokens(lightTokens, washi);
    expect(lightTokens).toEqual(before);
  });

  it("makes the neutral bubble the ink in light and leaves dark to the theme's own", () => {
    const light = dozoNeutralBubbleTokens(dozoThemeTokens(lightTokens, washi), "light");
    expect(light.chatUser).toBe(washi.palette.foreground);
    expect(light.chatUserForeground).toBe(washi.palette.background);
    const dark = dozoThemeTokens(darkTokens, sumi);
    expect(dozoNeutralBubbleTokens(dark, "dark")).toBe(dark);
  });
});
