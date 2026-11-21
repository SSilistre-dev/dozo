/**
 * A message that came in with a personal access token (the bot API, MCP) carries a client nonce
 * with this prefix, saved with the message. Runs it starts or reaches are held to the token gate
 * (packages/adapters/src/dozo-token-run.ts): what it asks for is asked about, never assumed to be
 * the owner's word. The app's own clients never send it; one that did would only be asked more.
 */
export const DOZO_TOKEN_NONCE_PREFIX = "api:";

/** The client nonce for a message sent with a token: the caller's retry key, or a fresh one. */
export function dozoTokenNonce(key: string): string {
  return `${DOZO_TOKEN_NONCE_PREFIX}${key}`;
}

/** Whether a message's client nonce says it came in with a token. */
export function isDozoTokenNonce(nonce: string | null | undefined): boolean {
  return Boolean(nonce?.startsWith(DOZO_TOKEN_NONCE_PREFIX));
}

/** What a message's payload carries to say it came in with a token, from its client nonce. */
export function dozoViaTokenField(nonce: string | null | undefined): { dozoViaToken?: true } {
  return isDozoTokenNonce(nonce) ? { dozoViaToken: true } : {};
}
