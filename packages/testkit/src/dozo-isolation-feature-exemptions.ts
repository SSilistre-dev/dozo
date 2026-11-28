import type { IsolationExemption } from "./dozo-isolation-exemptions.js";

/**
 * Exemptions of the procedures fork features add through the hubs (`dozo-features.ts`), kept apart
 * from the older ones so a feature adds its entries here; the kinds are those of
 * `ISOLATION_EXEMPTIONS`.
 */
export const FEATURE_EXEMPTIONS: readonly IsolationExemption[] = [
  {
    path: "dozoShareLinks/create",
    kind: "unreached",
    verifiedByCode:
      'apps/api/src/dozo-share-links.ts:96 "if (!kind || !(await kind.canShare(prisma, actor, input.targetId))) throw new IsolationError();" — the kind decides for the caller\'s own actor',
    reason:
      "No kind of share link ships yet, so every create is refused; the first bot kind makes the owner's call get through, and this entry must then go.",
  },
  {
    path: "dozoSpokenBriefings/set",
    kind: "unreached",
    verifiedByCode:
      "apps/api/src/dozo-spoken-briefings.ts:18 \"id: routineId, spaceId: actor.spaceId, userId: actor.userId,\" — only the caller's own routine in the caller's Space is found",
    reason:
      "A co-host must speak in a voice of its own, and the test world's bots have none, so the owner's own pick is refused as not found.",
  },
];
