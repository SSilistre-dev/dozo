import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { tokensForAppearance as lightOrDarkTokens } from "@rakazo/ui-tokens";
import type { DozoTheme } from "@rakazo/ui-tokens/dozo-themes";
import { dozoNeutralBubbleTokens, dozoThemeTokens } from "@rakazo/ui-tokens/dozo-themes";

// The named theme and the message colour of Settings > Appearance, as the screens read them. What
// is kept on the device is dozo-theme-store.ts; this file holds no native module, so the screens,
// sheets and styles that paint with it load nowhere the store cannot.

/** Your own bubble and the send button: the open bot's colour, or the theme's neutral tone. */
export type DozoBubble = "bot" | "neutral";

let active: DozoTheme | undefined;
let bubble: DozoBubble = "bot";
const listeners = new Set<() => void>();
// The tokens of each theme, made once: a screen reads them on every render.
const derived = new WeakMap<DozoTheme, ColorTokens>();

/** Marks what is chosen and tells every subscriber, the unchanged parts included. */
export function setDozoChoice(choice: { theme?: DozoTheme | undefined; bubble?: DozoBubble }) {
  if ("theme" in choice) active = choice.theme;
  if (choice.bubble) bubble = choice.bubble;
  for (const listener of listeners) listener();
}

/** The named theme painted now, or none for plain System, Light and Dark. */
export function getDozoTheme(): DozoTheme | undefined {
  return active;
}

export function getDozoBubble(): DozoBubble {
  return bubble;
}

export function subscribeDozoTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes whenever the theme or the message colour does: a screen's cue to build its styles again. */
export function dozoThemeKey(): string {
  return `${active?.id ?? ""}:${bubble}`;
}

const inked = new WeakMap<ColorTokens, ColorTokens>();

/** The product is monochrome: a link, a text action and a mention read in the ink, not system blue. */
function inkLinks(tokens: ColorTokens): ColorTokens {
  let result = inked.get(tokens);
  if (!result) {
    result = { ...tokens, link: tokens.foreground };
    inked.set(tokens, result);
  }
  return result;
}

/** Upstream's phone palette for a tone, or the named theme painted over it when it is that tone's. */
export function tokensForAppearance(appearance: ResolvedAppearance): ColorTokens {
  const base = lightOrDarkTokens(appearance);
  if (!active || active.tone !== appearance) return inkLinks(base);
  let tokens = derived.get(active);
  if (!tokens) {
    tokens = dozoThemeTokens(base, active);
    derived.set(active, tokens);
  }
  return inkLinks(tokens);
}

/** Your own bubble: the bot's colour when there is one, unless Message color is Neutral. */
export function dozoUserBubble(
  tokens: ColorTokens,
  userBubble: { background: string; foreground: string } | undefined,
): ColorTokens {
  if (bubble === "neutral") return active ? dozoNeutralBubbleTokens(tokens, active.tone) : tokens;
  return userBubble
    ? { ...tokens, chatUser: userBubble.background, chatUserForeground: userBubble.foreground }
    : tokens;
}
