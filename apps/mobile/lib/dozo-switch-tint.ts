import type { ColorTokens } from "@rakazo/ui-tokens";

// SwiftUI draws a switch's thumb white in every scheme and has no API to change it, so the track
// has to stand out from white: at least 3:1, the contrast WCAG asks of a control's parts.
const THUMB = "#FFFFFF";
export const SWITCH_MIN_CONTRAST = 3;

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/** WCAG contrast ratio of two six-digit hex colours. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** An on switch's track: the primary ink, or in a scheme where that is as pale as the thumb, the gray bubble tone. */
export function switchTrackTint(tokens: Pick<ColorTokens, "primary" | "chatUser">): string {
  return contrastRatio(tokens.primary, THUMB) >= SWITCH_MIN_CONTRAST
    ? tokens.primary
    : tokens.chatUser;
}
