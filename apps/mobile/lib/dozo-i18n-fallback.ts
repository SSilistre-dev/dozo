import type { I18n } from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";

/**
 * A release build compiles only the strings its catalogs list. One they do not list yet (every
 * fork string, and an upstream one until the catalogs catch up) falls back to its English text,
 * which Lingui then shows uncompiled: "Uses the relay at {0}." with the placeholder as written.
 * Compiling that fallback when it is used fills the placeholders in. Lingui's core already
 * bundles the compiler, so this adds no code to the app.
 */
export function compileMissingMessages(i18n: I18n) {
  i18n.setMessagesCompiler(compileMessage);
}
