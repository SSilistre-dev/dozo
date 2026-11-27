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

function mix(from: string, to: string, share: number): string {
  const part = (start: number) => {
    const a = Number.parseInt(from.slice(start, start + 2), 16);
    const b = Number.parseInt(to.slice(start, start + 2), 16);
    return Math.round(a + (b - a) * share)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${part(1)}${part(3)}${part(5)}`.toUpperCase();
}

/** iOS draws an off switch's track about this gray in the dark scheme. */
export const SWITCH_OFF_TRACK_DARK = "#535353";
export const SWITCH_ON_OFF_MIN_CONTRAST = 2;
const TARGET_CONTRAST = 3.4;

/**
 * An on switch's track: the primary ink, or in a scheme where that is as pale as the thumb, the
 * ink mixed toward the background until it clears the thumb with room left to stand apart from
 * the off track.
 */
export function switchTrackTint(tokens: Pick<ColorTokens, "primary" | "background">): string {
  if (contrastRatio(tokens.primary, THUMB) >= SWITCH_MIN_CONTRAST) return tokens.primary;
  for (let step = 1; step <= 100; step++) {
    const track = mix(tokens.primary, tokens.background, step / 100);
    if (contrastRatio(track, THUMB) >= TARGET_CONTRAST) return track;
  }
  return tokens.background;
}
