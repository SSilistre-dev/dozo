import { dozoShareLinkRoutes } from "./dozo-share-links.js";
import { dozoSpokenBriefingRoutes } from "./dozo-spoken-briefings.js";
import type { RouterContext } from "./routes/context.js";

/**
 * The fork's feature procedures, spread into the router by one anchored rule. A feature adds one
 * line here, `...<its>Routes(ctx)`, returning its key of `packages/contracts/src/dozo-features.ts`.
 */
export function dozoFeatureRoutes(ctx: RouterContext) {
  return {
    ...dozoShareLinkRoutes(ctx),
    ...dozoSpokenBriefingRoutes(ctx),
  };
}
