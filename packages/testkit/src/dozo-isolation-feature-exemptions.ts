import type { IsolationExemption } from "./dozo-isolation-exemptions.js";

/**
 * Exemptions of the procedures fork features add through the hubs (`dozo-features.ts`), kept apart
 * from the older ones so a feature adds its entries here; the kinds are those of
 * `ISOLATION_EXEMPTIONS`.
 */
export const FEATURE_EXEMPTIONS: readonly IsolationExemption[] = [
  {
    path: "dozoSpokenBriefings/set",
    kind: "unreached",
    verifiedByCode:
      "apps/api/src/dozo-spoken-briefings.ts:18 \"id: routineId, spaceId: actor.spaceId, userId: actor.userId,\" — only the caller's own routine in the caller's Space is found",
    reason:
      "A co-host must speak in a voice of its own, and the test world's bots have none, so the owner's own pick is refused as not found.",
  },
];
