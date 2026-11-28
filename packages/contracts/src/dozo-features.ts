import { dozoReplaysContract } from "./dozo-replays.js";
import { dozoShareLinksContract } from "./dozo-share-links.js";

export * from "./dozo-replays.js";
export * from "./dozo-share-links.js";

/**
 * The fork's feature procedures, spread into the app contract by one anchored rule. A feature adds
 * an `export *` line and one key here (its RPC namespace, `dozo` first), and its routes under the
 * same key in `apps/api/src/dozo-features.ts`.
 */
export const dozoFeaturesContract = /* @__PURE__ */ (() => ({
  dozoShareLinks: dozoShareLinksContract,
  dozoReplays: dozoReplaysContract,
}))();
