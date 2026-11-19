import type { BillingStatus, ByokTier } from "./billing.js";
import { BYOK_TIERS } from "./billing.js";
import { isComputerAllowanceUsed } from "./runs.js";

/**
 * What a client shows when a plan or server limit refuses something: one sentence and at most
 * one action. Web, the desktop apps (which host the web UI) and mobile all read this table.
 *
 * The server's codes are stable; the two computer-hours codes are the client's own, decided from
 * the billing status, because the refusal says only that no hours are left.
 */
export const PLAN_LIMIT_CODES = {
  /** The plan in force has no computer hours at all (Free). */
  computerNotInPlan: "computer_not_in_plan",
  /** A paid plan spent this period's hours. */
  computerHoursUsed: "computer_hours_used",
  sharedSpaceFull: "shared_space_full",
  computersBusy: "COMPUTERS_BUSY",
  computerLimit: "computer_limit_reached",
  spaceLimit: "space_limit_reached",
  planNotOffered: "plan_not_offered",
} as const;
export type PlanLimitCode = (typeof PLAN_LIMIT_CODES)[keyof typeof PLAN_LIMIT_CODES];

/** The busy-host sentence. The supervisor refusal's text, kept for run errors saved as text. */
export const COMPUTERS_BUSY_MESSAGE = "All computers are busy. Try again shortly.";

/** `upgrade` opens Billing; `startsPaidPlan` when the organization has no paid plan yet. */
export type PlanLimitAction =
  | { kind: "upgrade"; label: string; startsPaidPlan: boolean }
  | { kind: "retry"; label: string };
export type PlanLimitNotice = { code: PlanLimitCode; text: string; action: PlanLimitAction | null };

/** The part of the billing status the table reads. Absent where the caller has none. */
export type PlanLimitBilling = Pick<
  BillingStatus,
  "canManage" | "byokTier" | "byokTiers" | "funding" | "state"
>;

const COPY = {
  en: {
    computerNotInPlan: "Your plan doesn't include a computer.",
    computerNotInPlanAskOwner: "Your plan doesn't include a computer. Ask the owner to upgrade.",
    computerHoursUsed: "This month's computer hours are used up.",
    sharedSpaceFull: "Shared space is full. Delete files or change the plan.",
    sharedSpaceFullUpgrade: "Shared space is full. Delete files or upgrade.",
    sharedSpaceFullAskOwner: "Shared space is full. Delete files or ask the owner to upgrade.",
    sharedSpaceFullTop: "Shared space is full. Delete files to make room.",
    computersBusy: COMPUTERS_BUSY_MESSAGE,
    computerLimit: "Computer limit reached. Archive a bot to free one.",
    spaceLimit: "Space limit reached. Delete a Space to add another.",
    planNotOffered: "This plan is free. Choose a paid plan to upgrade.",
    upgrade: "Upgrade",
    upgradeTo: "Upgrade to {plan}",
    retry: "Try again",
  },
  tr: {
    computerNotInPlan: "Planınızda bilgisayar yok.",
    computerNotInPlanAskOwner: "Planınızda bilgisayar yok. Yükseltmesi için sahibine sorun.",
    computerHoursUsed: "Bu ayın bilgisayar saatleri tükendi.",
    sharedSpaceFull: "Paylaşılan alan dolu. Dosya silin ya da planı değiştirin.",
    sharedSpaceFullUpgrade: "Paylaşılan alan dolu. Dosya silin ya da yükseltin.",
    sharedSpaceFullAskOwner:
      "Paylaşılan alan dolu. Dosya silin ya da yükseltmesi için sahibine sorun.",
    sharedSpaceFullTop: "Paylaşılan alan dolu. Yer açmak için dosya silin.",
    computersBusy: "Tüm bilgisayarlar meşgul. Birazdan tekrar deneyin.",
    computerLimit: "Bilgisayar sınırına ulaşıldı. Yer açmak için bir botu arşivleyin.",
    spaceLimit: "Alan sınırına ulaşıldı. Yenisi için bir alanı silin.",
    planNotOffered: "Bu plan ücretsiz. Yükseltmek için ücretli bir plan seçin.",
    upgrade: "Yükselt",
    upgradeTo: "{plan} planına geç",
    retry: "Tekrar dene",
  },
} satisfies Record<string, Record<string, string>>;
type Copy = (typeof COPY)["en"];

/** English, or Turkish for a Turkish UI. The fork's own sentences have no other catalog. */
export function planLimitCopy(locale: string): Copy {
  return /^tr\b/i.test(locale) ? COPY.tr : COPY.en;
}

const SERVER_CODES = new Set<string>([
  PLAN_LIMIT_CODES.sharedSpaceFull,
  PLAN_LIMIT_CODES.computersBusy,
  PLAN_LIMIT_CODES.computerLimit,
  PLAN_LIMIT_CODES.spaceLimit,
  PLAN_LIMIT_CODES.planNotOffered,
]);

/** Each server code's sentence in every language, so text that kept no code is still known. */
const SENTENCES = new Map<string, PlanLimitCode>(
  Object.values(COPY).flatMap((copy) => [
    [copy.sharedSpaceFull, PLAN_LIMIT_CODES.sharedSpaceFull],
    [copy.computersBusy, PLAN_LIMIT_CODES.computersBusy],
    [copy.computerLimit, PLAN_LIMIT_CODES.computerLimit],
    [copy.spaceLimit, PLAN_LIMIT_CODES.spaceLimit],
    [copy.planNotOffered, PLAN_LIMIT_CODES.planNotOffered],
  ]),
);

/**
 * The limit a failure is, from an RPC error's code, or from text that kept no code: a failed
 * run's saved error (the hours refusal, the busy host) or a sentence this table already wrote,
 * such as a failed send's. Null for any other failure.
 */
export function planLimitOf(error: unknown): "computer_hours" | PlanLimitCode | null {
  const record =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  if (typeof record.code === "string" && SERVER_CODES.has(record.code))
    return record.code as PlanLimitCode;
  const message = typeof error === "string" ? error : record.message;
  if (typeof message !== "string") return null;
  if (isComputerAllowanceUsed(message.trim())) return "computer_hours";
  return SENTENCES.get(message.trim()) ?? null;
}

/** The next paid plan up from the one in force, or null on the top one or where none is sold. */
function nextPlan(billing: PlanLimitBilling): { name: string; fromFree: boolean } | null {
  const offers = billing.byokTiers ?? [];
  const tier: ByokTier = billing.byokTier ?? "standard";
  const fromFree = hasNoComputer(tier);
  if (fromFree) return offers[0] ? { name: offers[0].name, fromFree } : null;
  const index = offers.findIndex((offer) => offer.tier === tier);
  const next = index === -1 ? undefined : offers[index + 1];
  return next ? { name: next.name, fromFree } : null;
}

function hasNoComputer(tier: ByokTier): boolean {
  return BYOK_TIERS[tier].computerAllowanceCents === 0;
}

/**
 * The sentence and action for a limit. Without the billing status the sentence names no plan
 * action. Only a member who manages billing gets the upgrade; others are told to ask the owner.
 * Computer hours on a trial or a credit plan return null: upstream's own copy covers them.
 */
export function planLimitNotice(
  limit: "computer_hours" | PlanLimitCode,
  billing: PlanLimitBilling | null | undefined,
  locale: string,
): PlanLimitNotice | null {
  const copy = planLimitCopy(locale);
  const next = billing ? nextPlan(billing) : null;
  const upgrade = (label: string): PlanLimitAction | null =>
    billing?.canManage && next ? { kind: "upgrade", label, startsPaidPlan: next.fromFree } : null;
  const notice = (code: PlanLimitCode, text: string, action: PlanLimitAction | null = null) => ({
    code,
    text,
    action,
  });
  switch (limit) {
    case "computer_hours":
    case PLAN_LIMIT_CODES.computerNotInPlan:
    case PLAN_LIMIT_CODES.computerHoursUsed: {
      if (!billing || billing.state === "trialing" || billing.funding === "credits") return null;
      if (hasNoComputer(billing.byokTier ?? "standard"))
        return billing.canManage
          ? notice(
              PLAN_LIMIT_CODES.computerNotInPlan,
              copy.computerNotInPlan,
              upgrade(copy.upgrade),
            )
          : notice(PLAN_LIMIT_CODES.computerNotInPlan, copy.computerNotInPlanAskOwner);
      return notice(
        PLAN_LIMIT_CODES.computerHoursUsed,
        copy.computerHoursUsed,
        next ? upgrade(copy.upgradeTo.replace("{plan}", next.name)) : null,
      );
    }
    case PLAN_LIMIT_CODES.sharedSpaceFull: {
      const code = PLAN_LIMIT_CODES.sharedSpaceFull;
      if (!billing) return notice(code, copy.sharedSpaceFull);
      if (!next) return notice(code, copy.sharedSpaceFullTop);
      return billing.canManage
        ? notice(code, copy.sharedSpaceFullUpgrade, upgrade(copy.upgrade))
        : notice(code, copy.sharedSpaceFullAskOwner);
    }
    case PLAN_LIMIT_CODES.computersBusy:
      return notice(limit, copy.computersBusy, { kind: "retry", label: copy.retry });
    case PLAN_LIMIT_CODES.computerLimit:
      return notice(limit, copy.computerLimit);
    case PLAN_LIMIT_CODES.spaceLimit:
      return notice(limit, copy.spaceLimit);
    case PLAN_LIMIT_CODES.planNotOffered:
      return notice(limit, copy.planNotOffered);
  }
}

/**
 * The sentence alone, for a failure shown where no action fits (a toast, an alert). Computer
 * hours need the billing status to say why, so they keep the caller's text.
 */
export function planLimitText(error: unknown, locale: string): string | null {
  const limit = planLimitOf(error);
  if (!limit || limit === "computer_hours") return null;
  return planLimitNotice(limit, null, locale)?.text ?? null;
}
