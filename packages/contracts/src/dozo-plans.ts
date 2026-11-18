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
 */
const free = {
  name: "Free",
  monthlyPriceCents: null,
  annualPriceCents: null,
  computerAllowanceCents: 0,
} satisfies Partial<ByokTierTerms>;
const premium = { name: "Premium" } satisfies Partial<ByokTierTerms>;
const premiumPlus = { name: "Premium Plus" } satisfies Partial<ByokTierTerms>;

/** Rewrites upstream's tiers in place, before anything reads them. */
export function applyDozoPlans(tiers: Record<ByokTier, ByokTierTerms>): void {
  Object.assign(tiers.standard, free);
  Object.assign(tiers.pro, premium);
  Object.assign(tiers.max, premiumPlus);
}
