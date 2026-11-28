import { DOZO_STATS_SHARE_KIND } from "@rakazo/contracts";
import { dozoStatsShareKind } from "./dozo-bot-stats.js";
import type { DozoShareKinds } from "./dozo-share-links.js";

/**
 * What each kind of share link shows. A feature adds one line: `<kind>: <its DozoShareKind>`, with
 * the same key in the web's renderer map (`apps/web/src/pages/dozo-share-renderers.ts`). A kind
 * missing here is refused when a link is made and when one is read.
 */
export const DOZO_SHARE_KINDS: DozoShareKinds = Object.freeze({
  [DOZO_STATS_SHARE_KIND]: dozoStatsShareKind,
});
