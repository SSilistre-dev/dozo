import type { ModelCredentialAuthKind } from "./pi-catalog-availability.js";

/**
 * Which kinds of connection may join a model pool. A key the person holds, or their own endpoint,
 * may: running out of credit on one and moving to the next is their own billing. A subscription
 * sign-in may not; whether that is allowed is a separate decision.
 */
export const POOLABLE_CONNECTION_KINDS: Readonly<Record<ModelCredentialAuthKind, boolean>> = {
  api_key: true,
  openai_compatible: true,
  oauth: false,
};
