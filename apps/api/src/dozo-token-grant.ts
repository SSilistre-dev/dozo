/**
 * What a presented personal access token grants. The token store (issuing, hashing, revoking and
 * recording use) is the Bot API's; anything that accepts a token reads it only through this shape,
 * so the MCP endpoint and the Bot API share one token, one narrowing and one revocation.
 */
export type DozoTokenGrant = {
  id: string;
  userId: string;
  /** The one Space the token acts in. */
  spaceId: string;
  /** The one bot the token reaches, or null for all of the owner's bots in the Space. */
  botId: string | null;
};

/** The grant of a live, unrevoked token, or null for any token that is not one. */
export type DozoTokenVerifier = (token: string) => Promise<DozoTokenGrant | null>;
