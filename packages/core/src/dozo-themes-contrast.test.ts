import { BOT_COLOR_LIST } from "@rakazo/contracts";
import type { DozoThemePalette } from "@rakazo/ui-tokens/dozo-themes";
import { DOZO_THEMES } from "@rakazo/ui-tokens/dozo-themes";
import { describe, expect, it } from "vitest";
import { dozoBotFill, dozoContrast } from "./dozo-chat-colors.js";

// WCAG contrast of every named theme and of Light and Dark, measured on the surfaces they paint
// (dozo-shell.css derives the rest from these), and of both Message color choices in each.

type Palette = DozoThemePalette & { tone: "dark" | "light"; chatUser: string };

/** Light and Dark as dozo/theme/theme.json paints them. */
const DEFAULTS: Record<string, Palette> = {
  dark: {
    tone: "dark",
    sidebar: "#0a0a0a",
    background: "#141414",
    card: "#1f1f1f",
    popover: "#262626",
    foreground: "#ededed",
    mutedForeground: "#a3a3a3",
    faintForeground: "#8a8a8a",
    chatUser: "#262626",
  },
  light: {
    tone: "light",
    sidebar: "#ececea",
    background: "#f5f5f3",
    card: "#fdfdfc",
    popover: "#ffffff",
    foreground: "#1a1a1a",
    mutedForeground: "#5c5c5c",
    faintForeground: "#777777",
    chatUser: "#ffffff",
  },
};

const PALETTES: Record<string, Palette> = {
  ...DEFAULTS,
  ...Object.fromEntries(
    DOZO_THEMES.map((theme) => [
      theme.id,
      { tone: theme.tone, ...theme.palette, chatUser: theme.palette.popover },
    ]),
  ),
};

/** `color-mix(in srgb, ink share, base)`, as the stylesheet mixes its tone steps. */
function mix(ink: string, share: number, base: string): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(channel(ink, i) * share + channel(base, i) * (1 - share))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Every surface text sits on: dozo-shell.css's tone steps, rows and the chosen segment. */
function surfaces(p: Palette): Record<string, string> {
  return {
    background: p.background,
    sidebar: p.sidebar,
    card: p.card,
    popover: p.popover,
    botBubble: mix(p.foreground, 0.04, p.background),
    rowOn: mix(p.foreground, 0.09, p.sidebar),
    lift: p.tone === "dark" ? mix(p.foreground, 0.14, p.background) : p.popover,
  };
}

const worst = (ink: string, on: Record<string, string>) =>
  Math.min(...Object.values(on).map((surface) => dozoContrast(ink, surface)));

/** Your own bubble: its fill and its text, for each Message color choice. */
function bubbles(p: Palette): Record<"bot" | "neutral", number> {
  const fills = BOT_COLOR_LIST.filter(({ id }) => id !== "white").map(({ hex }) =>
    dozoBotFill(hex),
  );
  return {
    bot: Math.min(...fills.map((fill) => dozoContrast(fill, "#ffffff"))),
    neutral:
      p.tone === "dark"
        ? dozoContrast(p.foreground, p.chatUser)
        : dozoContrast(p.background, p.foreground),
  };
}

describe.each(Object.entries(PALETTES))("%s", (_name, palette) => {
  const on = surfaces(palette);

  it("holds text and secondary text at 4.5:1 on every surface", () => {
    expect(worst(palette.foreground, on)).toBeGreaterThanOrEqual(4.5);
    expect(worst(palette.mutedForeground, on)).toBeGreaterThanOrEqual(4.5);
  });

  it("holds faint text at 3:1 on every surface", () => {
    expect(worst(palette.faintForeground, on)).toBeGreaterThanOrEqual(3);
  });

  it("holds both Message color choices at 4.5:1", () => {
    const measured = bubbles(palette);
    expect(measured.bot).toBeGreaterThanOrEqual(4.5);
    expect(measured.neutral).toBeGreaterThanOrEqual(4.5);
  });
});
