import { dozoBotCallsRoutes } from "./dozo-bot-calls.js";
import { dozoBotShareRoutes } from "./dozo-bot-shares.js";
import { dozoComputerWallRoutes } from "./dozo-computer-wall.js";
import { dozoReplayRoutes } from "./dozo-replays.js";
import { dozoShareLinkRoutes } from "./dozo-share-links.js";
import type { RouterContext } from "./routes/context.js";

/**
 * The fork's feature procedures, spread into the router by one anchored rule. A feature adds one
 * line here, `...<its>Routes(ctx)`, returning its key of `packages/contracts/src/dozo-features.ts`.
 */
export function dozoFeatureRoutes(ctx: RouterContext) {
  return {
    ...dozoBotCallsRoutes(ctx),
    ...dozoComputerWallRoutes(ctx),
    ...dozoShareLinkRoutes(ctx),
    ...dozoBotShareRoutes(ctx),
    ...dozoReplayRoutes(ctx),
  };
}
