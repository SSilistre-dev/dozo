import type { ByokTier, ByokTierTerms } from "./billing.js";

/**
 * Dozo's plans, laid over upstream's own-model tiers. Tier ids and price lookup keys stay
 * upstream's (`standard`, `pro`, `max`); only what each tier is called and offers changes here.
 *
 * Free is permanent and takes no card: bots run on the member's own model connection and there is
 * no hosted computer. Premium and Premium Plus keep upstream's Pro and Max terms.
 *
 * This is the one place a price changes: add `monthlyPriceCents` and `annualPriceCents` to
 * `premium` or `premiumPlus` below. Until then they keep upstream's amounts. Existing subscribers
 * keep the price they signed up at.
 *
 * It is also the one place the shared-space limit changes: `sharedSpaceBytes`, the bytes of files
 * an organization may keep on a server that bills. Upstream's tiers carry no such field, so an
 * unbranded build has no limit.
 */
type DozoTerms = Partial<ByokTierTerms> & { sharedSpaceBytes: number };
const MB = 1024 * 1024;
const free = {
  name: "Free",
  monthlyPriceCents: null,
  annualPriceCents: null,
  computerAllowanceCents: 0,
  sharedSpaceBytes: 500 * MB,
} satisfies DozoTerms;
const premium = { name: "Premium", sharedSpaceBytes: 2 * 1024 * MB } satisfies DozoTerms;
const premiumPlus = { name: "Premium Plus", sharedSpaceBytes: 5 * 1024 * MB } satisfies DozoTerms;

/** Rewrites upstream's tiers in place, before anything reads them. */
export function applyDozoPlans(tiers: Record<ByokTier, ByokTierTerms>): void {
  Object.assign(tiers.standard, free);
  Object.assign(tiers.pro, premium);
  Object.assign(tiers.max, premiumPlus);
}
