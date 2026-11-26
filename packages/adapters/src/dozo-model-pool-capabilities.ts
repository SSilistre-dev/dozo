import type { ModelCredentialAuthKind } from "./runtime/pi/models/pi-catalog-availability.js";

/**
 * Which kinds of connection may join a model pool: every kind a person connects with their own
 * account. A key or their own endpoint is their own billing; a subscription sign-in is their own
 * subscription, used under its provider's terms, and its rest follows its account
 * (dozo-model-pool.ts).
 */
export const POOLABLE_CONNECTION_KINDS: Readonly<Record<ModelCredentialAuthKind, boolean>> = {
  api_key: true,
  openai_compatible: true,
  oauth: true,
};
