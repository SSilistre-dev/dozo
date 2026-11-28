import type { ByokTier, ByokTierTerms } from "./billing/billing.js";

/**
 * Dozo's plans, laid over upstream's own-model tiers. Tier ids and price lookup keys stay
 * upstream's (`standard`, `pro`, `max`); only what each tier is called and offers changes here.
 *
 * Free is permanent and takes no card: bots run on the member's own model connection and there is
 * no hosted computer. Premium and Premium Plus keep upstream's Pro and Max terms.
 *
 * This is the one place a price changes: add `monthlyPriceCents` and `annualPriceCents` to
 * `premium` or `premiumPlus` below. Until then they keep upstream's amounts, which upstream also
 * reads for what a plan includes (a free period's speech allowance, for one). Existing subscribers
 * keep the price they signed up at.
 *
 * Only the plans in `DOZO_PLANS_OFFERED` are offered: Premium Plus is not, though an admin can still
 * grant it with all its terms. An offered plan is sold only once it is also in
 * `DOZO_PLANS_ON_SALE`; until then it is shown as coming soon and the server refuses every checkout
 * and plan change that would bill it.
 *
 * The shared space (`sharedSpaceBytes`, the bytes of files an organization may keep on a server
 * that bills) and the computer allowance set here are each plan's terms: what the landing page
 * shows, and what holds until an admin sets another value on the admin plans page
 * (`packages/db/src/dozo-plan-quotas.ts`). Upstream's tiers carry no shared space, so an unbranded
 * build has no limit.
 *
 * `computers` is how many computers one person may have in use across their Spaces: Premium's one
 * is the Team Computer its bots share, with no computer of a bot's own. Free has none to count
 * (it has no hosted computer), so its limit is whatever the site sets.
 */
type DozoTerms = Partial<ByokTierTerms> & { sharedSpaceBytes: number; computers: number };
const MB = 1024 * 1024;
const free = {
  name: "Free",
  monthlyPriceCents: null,
  annualPriceCents: null,
  computerAllowanceCents: 0,
  sharedSpaceBytes: 500 * MB,
  computers: 0,
} satisfies DozoTerms;
const premium = {
  name: "Premium",
  sharedSpaceBytes: 2 * 1024 * MB,
  computers: 1,
} satisfies DozoTerms;
const premiumPlus = {
  name: "Premium Plus",
  sharedSpaceBytes: 5 * 1024 * MB,
  computers: 3,
} satisfies DozoTerms;

/** The paid plans offered, in Billing and on the landing page. */
export const DOZO_PLANS_OFFERED: readonly ByokTier[] = ["pro"] as const;

/** The offered plans on sale. Selling Premium is adding `"pro"` here. */
export const DOZO_PLANS_ON_SALE: readonly ByokTier[] = [] as const;

/** Whether Billing offers `tier`, as on sale or coming soon. */
export function planOffered(tier: ByokTier): boolean {
  return DOZO_PLANS_OFFERED.includes(tier);
}

/** Whether a checkout or plan change may bill `tier`. */
export function planOnSale(tier: ByokTier): boolean {
  return planOffered(tier) && DOZO_PLANS_ON_SALE.includes(tier);
}

/** Rewrites upstream's tiers in place, before anything reads them. */
export function applyDozoPlans(tiers: Record<ByokTier, ByokTierTerms>): void {
  Object.assign(tiers.standard, free);
  Object.assign(tiers.pro, premium);
  Object.assign(tiers.max, premiumPlus);
}
