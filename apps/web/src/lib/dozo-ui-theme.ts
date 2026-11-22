import { createStoredPreference } from "./stored-preference";
import type { AppearancePreference, ResolvedAppearance } from "./ui-appearance";
import { applyUiAppearance, setUiAppearance as setUpstreamAppearance } from "./ui-appearance";

// The named theme and the message colour of Settings > Appearance, per device like upstream's
// Light and Dark. public/dozo-boot.js applies both before first paint; this applies a change.

export { getUiAppearancePreference } from "./ui-appearance";

// Here, not beside the theme list in @rakazo/ui-tokens/dozo-themes: the startup code reads these,
// and importing that module would bring the list into the startup bundle. public/dozo-boot.js
// repeats both; its test holds them equal.
/** Per device, beside upstream's `rakazo.uiAppearance`, which keeps the theme's tone. */
export const DOZO_THEME_STORAGE_KEY = "dozo.uiTheme";
/** Your own bubble and the send button: the open bot's colour (no value) or "neutral". */
export const DOZO_BUBBLE_STORAGE_KEY = "dozo.uiBubble";

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
  // After the mark, so the browser's theme colour reads the theme's background.
  setUpstreamAppearance(theme.tone);
}

/** System, Light or Dark: any named theme goes first. The command menu calls this too. */
export function setUiAppearance(preference: AppearancePreference): ResolvedAppearance {
  dozoThemePreference.set(null);
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
}

// The page's marks follow the two preferences from this one place, whether the change was made
// here or in another tab (the preference re-reads storage on its event). Another tab's theme also
// stored its tone in upstream's choice, which this tab applies again.
dozoThemePreference.subscribe(() => {
  mark("skin", dozoThemePreference.get());
  applyUiAppearance();
});
dozoBubblePreference.subscribe(() => {
  mark("bubble", dozoBubblePreference.get() === "neutral" ? "neutral" : null);
});

/** True when your own bubble and the send button take the theme's neutral tone. */
export function useDozoNeutralBubble(): boolean {
  return dozoBubblePreference.use() === "neutral";
}
