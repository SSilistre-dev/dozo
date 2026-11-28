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
    path: "dozoBotShares/clone",
    kind: "no-target",
    fields: ["requestId"],
    reason:
      "A random id the client makes for one copy, so a retry returns the same bot: it names nothing anyone keeps; the link is named by its token.",
  },
];
