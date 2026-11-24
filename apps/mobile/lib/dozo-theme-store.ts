import { dozoTheme } from "@rakazo/ui-tokens/dozo-themes";
import * as SecureStore from "expo-secure-store";
import type { DozoBubble } from "./dozo-theme";
import { getDozoBubble, getDozoTheme, setDozoChoice } from "./dozo-theme";

// Where the named theme and the message colour are kept on this device, under the names the web app
// uses. The theme's tone is stored as upstream's Light or Dark choice, as on the web, so a name that
// is gone, or whose tone is not the stored choice, reads as plain Light or Dark. There is no
// account copy: the server has no field for it.

export const DOZO_THEME_STORAGE_KEY = "dozo.uiTheme";
export const DOZO_BUBBLE_STORAGE_KEY = "dozo.uiBubble";

// Writes go out in the order they were made, so the last pick is the one stored.
let writes: Promise<void> = Promise.resolve();

function store(key: string, value: string | null) {
  writes = writes.then(async () => {
    try {
      if (value === null) await SecureStore.deleteItemAsync(key);
      else await SecureStore.setItemAsync(key, value);
    } catch {
      // Keep the in-memory choice when SecureStore is unavailable.
    }
  });
}

/**
 * Reads both choices once the stored Light or Dark is known. A theme counts only beside its own
 * tone. Subscribers hear of it only when something changed. Never throws: with no store the plain
 * palettes stay.
 */
export async function loadDozoTheme(preference: string): Promise<void> {
  try {
    const [id, stored] = await Promise.all([
      SecureStore.getItemAsync(DOZO_THEME_STORAGE_KEY),
      SecureStore.getItemAsync(DOZO_BUBBLE_STORAGE_KEY),
    ]);
    const theme = dozoTheme(id);
    const next = theme && theme.tone === preference ? theme : undefined;
    const bubble = stored === "neutral" ? "neutral" : "bot";
    if (next !== getDozoTheme() || bubble !== getDozoBubble())
      setDozoChoice({ theme: next, bubble });
  } catch {
    // Keep what is in memory when SecureStore is unavailable.
  }
}

/** Marks the named theme (null: none) and stores it. The caller sets the tone beside it. */
export function setDozoTheme(id: string | null): void {
  const theme = dozoTheme(id);
  store(DOZO_THEME_STORAGE_KEY, theme ? theme.id : null);
  setDozoChoice({ theme });
}

export function setDozoBubble(bubble: DozoBubble): void {
  store(DOZO_BUBBLE_STORAGE_KEY, bubble === "neutral" ? "neutral" : null);
  setDozoChoice({ bubble });
}
