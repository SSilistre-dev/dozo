import { DOZO_BUBBLE_STORAGE_KEY, DOZO_THEME_STORAGE_KEY } from "@rakazo/ui-tokens/dozo-themes";
import { createStoredPreference } from "./stored-preference";
import type { AppearancePreference, ResolvedAppearance } from "./ui-appearance";
import { setUiAppearance as setUpstreamAppearance } from "./ui-appearance";

// The named theme and the message colour of Settings > Appearance, per device like upstream's
// Light and Dark. public/dozo-boot.js applies both before first paint; this applies a change.

export { getUiAppearancePreference } from "./ui-appearance";

function mark(name: "skin" | "bubble", value: string | null) {
  const root = document.documentElement;
  if (value === null) delete root.dataset[name];
  else root.dataset[name] = value;
}

/** The stored theme name, unchecked: the picker looks it up and compares its tone. */
export const dozoThemePreference = createStoredPreference<string | null>({
  key: DOZO_THEME_STORAGE_KEY,
  parse: (raw) => raw,
  serialize: (id) => id,
});

/** A named theme, stored as upstream's Light or Dark (its tone) with its name beside it. */
export function setDozoTheme(theme: { id: string; tone: ResolvedAppearance }): void {
  dozoThemePreference.set(theme.id);
  mark("skin", theme.id);
  // After the mark, so the browser's theme colour reads the theme's background.
  setUpstreamAppearance(theme.tone);
}

/** System, Light or Dark: any named theme goes first. The command menu calls this too. */
export function setUiAppearance(preference: AppearancePreference): ResolvedAppearance {
  dozoThemePreference.set(null);
  mark("skin", null);
  return setUpstreamAppearance(preference);
}

export type DozoBubble = "bot" | "neutral";

/** Your own bubble and the send button: the open bot's colour, or the theme's neutral tone. */
export const dozoBubblePreference = createStoredPreference<DozoBubble>({
  key: DOZO_BUBBLE_STORAGE_KEY,
  parse: (raw) => (raw === "neutral" ? "neutral" : "bot"),
  serialize: (bubble) => (bubble === "neutral" ? "neutral" : null),
});

export function setDozoBubble(bubble: DozoBubble): void {
  dozoBubblePreference.set(bubble);
  mark("bubble", bubble === "neutral" ? "neutral" : null);
}

/** True when your own bubble and the send button take the theme's neutral tone. */
export function useDozoNeutralBubble(): boolean {
  return dozoBubblePreference.use() === "neutral";
}
