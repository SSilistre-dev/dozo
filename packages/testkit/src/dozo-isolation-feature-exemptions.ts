import type { IsolationExemption } from "./dozo-isolation-exemptions.js";

/**
 * Exemptions of the procedures fork features add through the hubs (`dozo-features.ts`), kept apart
 * from the older ones so a feature adds its entries here; the kinds are those of
 * `ISOLATION_EXEMPTIONS`.
 */
export const FEATURE_EXEMPTIONS: readonly IsolationExemption[] = [
  {
    path: "dozoBotShares/publish",
    kind: "reached-409",
    reason:
      'The handler found the caller\'s own bot and built its definition; the generated fingerprint is not the one its preview gave, so the publish is refused as changed ("This bot changed. Look at it again first").',
  },
  {
    path: "dozoShareLinks/create",
    kind: "unreached",
    variant: "bot: all ids",
    verifiedByCode:
      'apps/api/src/dozo-share-links.ts:185 "if (kindOf(kinds, input.kind)?.featureOnly) throw new IsolationError();" — a bot link comes only from its reviewed publish',
    reason:
      "The generic create refuses a bot link to everyone, its owner too, before any target is looked up: only `dozoBotShares/publish`, after the owner's review, makes one. Another member's bot is tried through that publish and the kind's own `canShare`.",
  },
  {
    path: "dozoBotShares/clone",
    kind: "no-target",
    fields: ["requestId"],
    reason:
      "A random id the client makes for one copy, so a retry returns the same bot: it names nothing anyone keeps; the link is named by its token.",
  },
];
