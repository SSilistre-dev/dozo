import type { PlanLimitCopy, PlanLimitNotice, SignInProvider } from "@rakazo/contracts";
import {
  HOSTED_MODEL_CREDITS_REQUIRED_ERROR,
  MISSING_MODEL_RUN_ERROR,
  MODEL_ACCESS_REQUIRED_RUN_ERROR,
  MODEL_CREDITS_EXHAUSTED_ERROR,
} from "@rakazo/core";
import { planLimitCopy } from "@rakazo/i18n/run-error";

/**
 * The App Store build (`dozo/mobile/build.sh archive`), fixed when the bundle is made. It sells
 * nothing: no plan, price or credit purchase, no link to a payment page, no prompt to upgrade
 * (App Review 3.1.1). A plan bought elsewhere still works; the app only stops offering one.
 */
export const storeBuild = process.env.EXPO_PUBLIC_DOZO_STORE_BUILD === "1";

/**
 * The plan-limit sentences, with those that point at a purchase replaced by one that does not:
 * the limit is still named, and deleting files stays the way out of a full shared space.
 */
export function storePlanLimitCopy(copy: PlanLimitCopy, store = storeBuild): PlanLimitCopy {
  if (!store) return copy;
  return {
    ...copy,
    computerNotInPlanAskOwner: copy.computerNotInPlan,
    sharedSpaceFull: copy.sharedSpaceFullTop,
    sharedSpaceFullUpgrade: copy.sharedSpaceFullTop,
    sharedSpaceFullAskOwner: copy.sharedSpaceFullTop,
  };
}

/** The plan-limit copy the app shows, in the UI's language. */
export function mobilePlanLimitCopy(store = storeBuild): PlanLimitCopy {
  return storePlanLimitCopy(planLimitCopy(), store);
}

/** A plan-limit notice without its upgrade in the store build; a retry stays. */
export function storePlanLimitNotice<T extends PlanLimitNotice | null>(
  notice: T,
  store = storeBuild,
): T {
  if (!store || notice?.action?.kind !== "upgrade") return notice;
  return { ...notice, action: null };
}

/** The computer-hours sentence, with its Start plan now, Renew plan or Upgrade action dropped in the store build. */
export function storeComputerHoursOut(
  copy: { summary: string; action: string },
  store = storeBuild,
): { summary: string; action: string | null } {
  return store ? { summary: copy.summary, action: null } : copy;
}

/** Run failures whose advice is to buy credits or a plan in Billing. */
const PURCHASE_RUN_ERRORS = [
  HOSTED_MODEL_CREDITS_REQUIRED_ERROR,
  MODEL_CREDITS_EXHAUSTED_ERROR,
  MODEL_ACCESS_REQUIRED_RUN_ERROR,
];

/**
 * A failed run's saved error, with advice to buy in Billing replaced in the store build by the
 * advice that is open to everyone there: connect a model. It is then read as that failure.
 */
export function storeRunErrorDetails(details: string, store = storeBuild): string {
  if (!store) return details;
  return PURCHASE_RUN_ERRORS.reduce(
    (text, sentence) => text.split(sentence).join(MISSING_MODEL_RUN_ERROR),
    details,
  );
}

/**
 * The sign-in buttons. App Review 4.8: a store app that offers a third-party sign-in must offer
 * Sign in with Apple beside it, so without Apple the store build keeps only organization sign-in,
 * which 4.8 exempts, and email.
 */
export function storeSignInProviders(
  providers: SignInProvider[],
  store = storeBuild,
): SignInProvider[] {
  if (!store || providers.some((provider) => provider.id === "apple")) return providers;
  return providers.filter((provider) => provider.id === "oidc");
}
