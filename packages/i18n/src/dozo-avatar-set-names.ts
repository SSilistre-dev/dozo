import { i18n } from "@lingui/core";

/**
 * What a bot icon set is called wherever one is chosen: the Avatar Studio's tabs on web and
 * mobile and the account's "Bot style" setting. The stored values never change;
 * the names say what each set is, the characters or the plain marks. The English is its own
 * catalog id, and the Turkish is in the fork's catalog block.
 */
export function botAvatarSetName(set: string): string {
  const message = set === "rakazo" ? "Simple" : "Character";
  return i18n._({ id: message, message });
}
