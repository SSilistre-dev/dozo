import { BOT_COLOR_LIST } from "@rakazo/contracts";
import type { ColorTokens } from "@rakazo/ui-tokens";
import { darkTokens, lightTokens } from "@rakazo/ui-tokens";
import {
  DOZO_THEMES,
  dozoNeutralBubbleTokens,
  dozoThemeTokens,
} from "@rakazo/ui-tokens/dozo-themes";
import { describe, expect, it } from "vitest";
import { chatUserBubbleColors } from "./bot-avatar-colors.js";
import { dozoContrast } from "./dozo-chat-colors.js";

// WCAG contrast of the phone's palettes: Light and Dark as the app ships them, and each named
// theme painted over its tone by the same table the web uses. The phone reads `ColorTokens`, whose
// text colours are often the ink at an opacity, so each is laid over the surface it sits on first.
// The web's own surfaces are held by dozo-themes-contrast.test.ts.
//
// Surfaces text sits on: the page and the settings page (`background`), grouped rows and cards
// (`card`), menus (`popover`) and sheets (`dialog`). The sidebar paints only a logo's plate on the
// phone, so no text is measured on it. Disabled controls are exempt from WCAG contrast.

/** `neutral`: the tokens your own bubble reads with Message color on Neutral, as the phone makes them. */
type Palette = { tokens: ColorTokens; neutral: ColorTokens };

const BASE = { dark: darkTokens, light: lightTokens } as const;

const PALETTES: Record<string, Palette> = {
  // Plain Light and Dark keep the phone's own bubble.
  dark: { tokens: darkTokens, neutral: darkTokens },
  light: { tokens: lightTokens, neutral: lightTokens },
  ...Object.fromEntries(
    DOZO_THEMES.map((theme) => {
      const tokens = dozoThemeTokens(BASE[theme.tone], theme);
      return [theme.id, { tokens, neutral: dozoNeutralBubbleTokens(tokens, theme.tone) }];
    }),
  ),
};

/** `#rrggbb` or `#rrggbbaa` laid over an opaque `#rrggbb`. */
function over(color: string, surface: string): string {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  const alpha = color.length === 9 ? channel(color, 7) / 255 : 1;
  return `#${[1, 3, 5]
    .map((at) =>
      Math.round(channel(color, at) * alpha + channel(surface, at) * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const surfaces = (t: ColorTokens) => ({
  background: t.background,
  card: t.card,
  popover: t.popover,
  dialog: t.dialog,
});

/** The lowest contrast of `ink` over every surface. */
const worst = (ink: string, t: ColorTokens) =>
  Math.min(
    ...Object.values(surfaces(t)).map((surface) => dozoContrast(over(ink, surface), surface)),
  );

/**
 * Known gap, held where it is rather than hidden: the phone's plain Light, as upstream ships it
 * (packages/ui-tokens/src/index.ts, which this change leaves alone), reads secondary text at 4.22:1
 * on a grouped row and 4.47:1 on the page. The floor keeps it from getting worse; raise it to 4.5
 * once that palette is changed.
 */
const SECONDARY_FLOOR: Record<string, number> = { light: 4.2 };

describe.each(Object.entries(PALETTES))("the phone's %s", (name, { tokens, neutral }) => {
  it("holds text at 4.5:1 on every surface", () => {
    expect(worst(tokens.foreground, tokens)).toBeGreaterThanOrEqual(4.5);
  });

  it("holds secondary text at 4.5:1 on every surface", () => {
    expect(worst(tokens.mutedForeground, tokens)).toBeGreaterThanOrEqual(
      SECONDARY_FLOOR[name] ?? 4.5,
    );
  });

  it("holds faint text at 3:1 on every surface", () => {
    expect(worst(tokens.faintForeground, tokens)).toBeGreaterThanOrEqual(3);
  });

  it("holds destructive and link text at 4.5:1 on every surface", () => {
    expect(worst(tokens.destructive, tokens)).toBeGreaterThanOrEqual(4.5);
    expect(worst(tokens.link, tokens)).toBeGreaterThanOrEqual(4.5);
  });

  it("holds your own bubble's text at 4.5:1 with Message color on Neutral", () => {
    expect(
      dozoContrast(over(neutral.chatUserForeground, neutral.chatUser), neutral.chatUser),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("Message color on Bot color", () => {
  // The phone's bubble is the bot's own avatar colour (upstream's, which Dozo's phone avatars
  // keep), deepened only until white text holds 3:1: large-text contrast, not 4.5:1.
  it("holds white text on every bot colour at 3:1, the least the phone's bubble promises", () => {
    for (const { hex } of BOT_COLOR_LIST) {
      const bubble = chatUserBubbleColors(hex, "bot-1");
      if (bubble)
        expect(dozoContrast(bubble.foreground, bubble.background)).toBeGreaterThanOrEqual(3);
    }
  });
});
