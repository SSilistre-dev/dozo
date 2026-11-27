import type { ColorTokens } from "@rakazo/ui-tokens";

// SwiftUI draws a switch's thumb white in every scheme and has no API to change it, so the track
// has to stand out from white: at least 3:1, the contrast WCAG asks of a control's parts.
const THUMB = "#FFFFFF";
export const SWITCH_MIN_CONTRAST = 3;

function channel(hex: string, start: number): number {
  const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG contrast ratio of two six-digit hex colours. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** An on switch's track: the primary ink, or in a scheme where that is as pale as the thumb, the gray bubble tone. */
export function switchTrackTint(tokens: Pick<ColorTokens, "primary" | "chatUser">): string {
  return contrastRatio(tokens.primary, THUMB) >= SWITCH_MIN_CONTRAST
    ? tokens.primary
    : tokens.chatUser;
}
