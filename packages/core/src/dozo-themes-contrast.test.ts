import { BOT_COLOR_LIST } from "@rakazo/contracts";
import type { ResolvedAppearance } from "@rakazo/ui-tokens";
import { webDarkTokens, webLightTokens } from "@rakazo/ui-tokens";
import type { DozoThemePalette } from "@rakazo/ui-tokens/dozo-themes";
import { DOZO_DEFAULT_PALETTES, DOZO_THEMES } from "@rakazo/ui-tokens/dozo-themes";
import { describe, expect, it } from "vitest";
import { dozoBotFill, dozoContrast } from "./dozo-chat-colors.js";

// WCAG contrast of every named theme and of Light and Dark, measured on the surfaces they paint
// (dozo-shell.css derives the rest from these), and of both Message color choices in each.
//
// What else reads these surfaces, and where it is covered:
// - placeholders, icons and keyboard focus use the second ink (`--dozo-ink-3`, `--dozo-focus`):
//   the muted text below, which also clears the 3:1 a focus ring needs;
// - the selected sidebar row's text: `rowOn` below; a code block sits on `secondary`, the popover;
// - a link in your own bubble wears the bubble's text colour (underlined): the bubble below;
// - disabled controls are exempt from WCAG contrast and are not measured.

type Palette = DozoThemePalette & { tone: ResolvedAppearance; chatUser: string };

const PALETTES: Record<string, Palette> = {
  dark: { tone: "dark", ...DOZO_DEFAULT_PALETTES.dark },
  light: { tone: "light", ...DOZO_DEFAULT_PALETTES.light },
  ...Object.fromEntries(
    DOZO_THEMES.map((theme) => [
      theme.id,
      { tone: theme.tone, ...theme.palette, chatUser: theme.palette.popover },
    ]),
  ),
};

/** Status and link colours are upstream's and no theme changes them. */
const STATUS = { dark: webDarkTokens, light: webLightTokens } as const;

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

/** The four painted surfaces, where status and link text appear. */
const painted = (p: Palette) => ({
  background: p.background,
  sidebar: p.sidebar,
  card: p.card,
  popover: p.popover,
});

/** Every surface text sits on: the painted ones, dozo-shell.css's tone steps and rows. */
const surfaces = (p: Palette) => ({
  ...painted(p),
  botBubble: mix(p.foreground, 0.04, p.background),
  rowOn: mix(p.foreground, 0.09, p.sidebar),
  lift: p.tone === "dark" ? mix(p.foreground, 0.14, p.background) : p.popover,
});

const worst = (ink: string, on: Record<string, string>) =>
  Math.min(...Object.values(on).map((surface) => dozoContrast(ink, surface)));

/** Destructive and link text on the painted surfaces, at their worst. */
const status = (p: Palette) => ({
  destructive: worst(STATUS[p.tone].destructive, painted(p)),
  link: worst(STATUS[p.tone].link, painted(p)),
});

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

describe.each(DOZO_THEMES.map((theme) => [theme.id, PALETTES[theme.id] as Palette] as const))(
  "%s, against the default of its tone",
  (_id, palette) => {
    const own = status(palette);
    const base = status(PALETTES[palette.tone] as Palette);

    it("holds destructive text at 4.5:1 on every painted surface", () => {
      expect(own.destructive).toBeGreaterThanOrEqual(4.5);
    });

    it("reads destructive and link text at least as well as the default does", () => {
      expect(own.destructive).toBeGreaterThanOrEqual(base.destructive);
      expect(own.link).toBeGreaterThanOrEqual(base.link);
    });
  },
);
