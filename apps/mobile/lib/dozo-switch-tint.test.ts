import type { ColorTokens } from "@rakazo/ui-tokens";
import { darkTokens, lightTokens } from "@rakazo/ui-tokens";
import { DOZO_THEMES, dozoThemeTokens } from "@rakazo/ui-tokens/dozo-themes";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  SWITCH_MIN_CONTRAST,
  SWITCH_OFF_TRACK_DARK,
  SWITCH_ON_OFF_MIN_CONTRAST,
  switchTrackTint,
} from "./dozo-switch-tint";

// SwiftUI's switch thumb is white in every scheme.
const THUMB = "#FFFFFF";

const palettes: [string, ColorTokens][] = [
  ["light", lightTokens],
  ["dark", darkTokens],
  ...DOZO_THEMES.map((theme): [string, ColorTokens] => [
    theme.label,
    dozoThemeTokens(theme.tone === "dark" ? darkTokens : lightTokens, theme),
  ]),
];

describe("an on switch's track", () => {
  it.each(palettes)("stands out from the white thumb in %s", (_name, tokens) => {
    expect(contrastRatio(switchTrackTint(tokens), THUMB)).toBeGreaterThanOrEqual(
      SWITCH_MIN_CONTRAST,
    );
  });

  it.each(palettes.filter(([, tokens]) => contrastRatio(tokens.primary, THUMB) < 3))(
    "stands out from the off track in %s",
    (_name, tokens) => {
      expect(
        contrastRatio(switchTrackTint(tokens), SWITCH_OFF_TRACK_DARK),
      ).toBeGreaterThanOrEqual(SWITCH_ON_OFF_MIN_CONTRAST);
    },
  );

  it("is the primary ink where that contrasts, and not the pale one of the dark palette", () => {
    expect(switchTrackTint(lightTokens)).toBe(lightTokens.primary);
    expect(contrastRatio(darkTokens.primary, THUMB)).toBeLessThan(SWITCH_MIN_CONTRAST);
    expect(switchTrackTint(darkTokens)).not.toBe(darkTokens.primary);
  });

  it("measures contrast as WCAG does", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBe(1);
  });
});
