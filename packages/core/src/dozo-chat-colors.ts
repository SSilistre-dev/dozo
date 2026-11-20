import { parseBotAvatarValue } from "@rakazo/contracts";
import { DOZO_BOT_PALETTE, dozoCharacterForLook } from "./dozo-avatar-art.js";

/** Text on a bot-coloured fill: your own bubble and the send button. */
const ON_BOT_INK = "#ffffff";
const ON_BOT_CONTRAST = 4.5;

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function dozoContrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The character's colour mixed with black, as the design does (72% colour), and darkened further
 * only as far as white text on it needs for 4.5:1.
 */
function botFill(hex: string): string {
  for (let share = 0.72; ; share -= 0.02) {
    const fill = `#${[1, 3, 5]
      .map((i) =>
        Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * share)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
    if (dozoContrast(fill, ON_BOT_INK) >= ON_BOT_CONTRAST) return fill;
  }
}

/**
 * Your own bubble and the send button in a bot's chat wear that bot's identity colour, one value
 * per theme (`light-dark()` follows the page's color-scheme). A photo avatar has no identity
 * colour, so its chat keeps the theme's neutral bubble.
 */
export function dozoChatUserColors(
  avatarValue: string,
  identity: string,
): { background: string; foreground: string } | undefined {
  if (parseBotAvatarValue(avatarValue).kind === "image") return undefined;
  const [light, dark] =
    DOZO_BOT_PALETTE[dozoCharacterForLook(identity || avatarValue, avatarValue)];
  return { background: `light-dark(${botFill(light)}, ${botFill(dark)})`, foreground: ON_BOT_INK };
}
