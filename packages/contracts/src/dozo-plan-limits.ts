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

/**
 * The table's sentences and labels, in the UI's language. Clients build it from their translation
 * catalog (`planLimitCopy` in `packages/i18n/src/dozo-plan-limits.ts`), so this table holds no copy.
 */
export type PlanLimitCopy = {
  computerNotInPlan: string;
  computerNotInPlanAskOwner: string;
  computerHoursUsed: string;
  /** The hours refusal where the plan behind it is not known. */
  noComputerHours: string;
  sharedSpaceFull: string;
  sharedSpaceFullUpgrade: string;
  sharedSpaceFullAskOwner: string;
  sharedSpaceFullTop: string;
  computersBusy: string;
  computerLimit: string;
  spaceLimit: string;
  planNotOffered: string;
  upgrade: string;
  upgradeTo: (plan: string) => string;
  retry: string;
};

/** The server's own sentence for a full shared space, for text that kept no code. */
export const SHARED_SPACE_FULL_MESSAGE = "Shared space is full. Delete files or change the plan.";

const SERVER_CODES = new Set<string>([
  PLAN_LIMIT_CODES.sharedSpaceFull,
  PLAN_LIMIT_CODES.computersBusy,
  PLAN_LIMIT_CODES.computerLimit,
  PLAN_LIMIT_CODES.spaceLimit,
  PLAN_LIMIT_CODES.planNotOffered,
]);

/** Text that names a limit: the server's own sentences, and the copy's when the client has it. */
function sentenceLimit(text: string, copy: PlanLimitCopy | undefined): PlanLimitCode | null {
  if (text === COMPUTERS_BUSY_MESSAGE) return PLAN_LIMIT_CODES.computersBusy;
  if (text === SHARED_SPACE_FULL_MESSAGE) return PLAN_LIMIT_CODES.sharedSpaceFull;
  if (!copy) return null;
  const sentences: [string, PlanLimitCode][] = [
    [copy.sharedSpaceFull, PLAN_LIMIT_CODES.sharedSpaceFull],
    [copy.computersBusy, PLAN_LIMIT_CODES.computersBusy],
    [copy.computerLimit, PLAN_LIMIT_CODES.computerLimit],
    [copy.spaceLimit, PLAN_LIMIT_CODES.spaceLimit],
    [copy.planNotOffered, PLAN_LIMIT_CODES.planNotOffered],
  ];
  return sentences.find(([sentence]) => sentence === text)?.[1] ?? null;
}

/**
 * The limit a failure is, from an RPC error's code, or from text that kept no code: a failed
 * run's saved error (the hours refusal, the busy host) or, given the copy, a sentence this table
 * already wrote, such as a failed send's. Null for any other failure.
 */
export function planLimitOf(
  error: unknown,
  copy?: PlanLimitCopy,
): "computer_hours" | PlanLimitCode | null {
  const record =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  if (typeof record.code === "string" && SERVER_CODES.has(record.code))
    return record.code as PlanLimitCode;
  const message = typeof error === "string" ? error : record.message;
  if (typeof message !== "string") return null;
  const text = message.trim();
  if (isComputerAllowanceUsed(text) || (copy && text === copy.noComputerHours))
    return "computer_hours";
  return sentenceLimit(text, copy);
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
 * Without the billing status they say only that no hours are left.
 */
export function planLimitNotice(
  limit: "computer_hours" | PlanLimitCode,
  billing: PlanLimitBilling | null | undefined,
  copy: PlanLimitCopy,
): PlanLimitNotice | null {
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
      if (!billing) return notice(PLAN_LIMIT_CODES.computerHoursUsed, copy.noComputerHours);
      if (billing.state === "trialing" || billing.funding === "credits") return null;
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
        next ? upgrade(copy.upgradeTo(next.name)) : null,
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
 * hours need the billing status to say why, so they keep the caller's text: the computer screens
 * recognise it and say why themselves.
 */
export function planLimitText(error: unknown, copy: PlanLimitCopy): string | null {
  const limit = planLimitOf(error, copy);
  if (!limit || limit === "computer_hours") return null;
  return planLimitNotice(limit, null, copy)?.text ?? null;
}
