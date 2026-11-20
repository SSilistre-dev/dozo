import { t } from "@lingui/core/macro";
import { embeddableScreenUrl as directScreenUrl } from "./computer";
import { isRelayOrigin } from "./dozo-relay-connection";
import {
  apiBaseWarning as directApiBaseWarning,
  displayApiHost as directApiHost,
} from "./endpoint";

/**
 * The endpoint helpers for screens that also see a paired computer. Only JavaScript's `fetch`
 * crosses the relay: what the system loads by itself (Android's background notification service,
 * a computer's live screen in a web view) cannot, so those say no here instead of failing later.
 */

export { normalizeApiBase, usesCustomApiBase } from "./endpoint";

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

export function displayApiHost(url: string) {
  return isRelayOrigin(originOf(url)) ? t`Your computer` : directApiHost(url);
}

/** Android's notification service calls the server itself, which a paired computer is not. */
export function apiBaseWarning(url: string): string | null {
  if (isRelayOrigin(originOf(url))) {
    return t`Background notifications need a direct connection to the server.`;
  }
  return directApiBaseWarning(url);
}

/** A computer's live screen loads in a web view, which cannot reach a paired computer. */
export function embeddableScreenUrl(url: string | null, apiBase: string): string | null {
  return isRelayOrigin(originOf(apiBase)) ? null : directScreenUrl(url, apiBase);
}
