import { getActiveUiLocale } from "./i18n";

/**
 * Tells the auth server the language the app is shown in. An account has no saved language until
 * its first sign-in, so the server writes the emails before that (verify your address, sign-in
 * code) in the asking browser's language; a visitor who chose another one on the sign-in page
 * would get them in the wrong one.
 */
export function sendUiLocale<T extends { headers: Headers }>(request: T): T {
  request.headers.set("accept-language", getActiveUiLocale());
  return request;
}
