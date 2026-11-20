import { relayVerifier, webRelayCrypto } from "@dozo/relay-core/dozo-relay-channel";

const relayCrypto = webRelayCrypto();
/** A token the ends make is base64url of 32 bytes; anything far longer is not one. */
const MAX_TOKEN = 256;
const BEARER = /^Bearer ([\x21-\x7e]{1,256})$/;

/**
 * The verifier of the request's bearer token as ASCII bytes, ready for a constant-time compare
 * with a stored one, or null when there is no usable token. The token itself is never kept.
 */
export async function verifierOf(request: Request): Promise<Uint8Array | null> {
  const header = request.headers.get("Authorization");
  if (!header || header.length > MAX_TOKEN + 7) return null;
  const token = BEARER.exec(header)?.[1];
  if (!token) return null;
  return new TextEncoder().encode(await relayVerifier(relayCrypto, token));
}
