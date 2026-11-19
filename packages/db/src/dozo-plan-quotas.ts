import type { ByokTier } from "@rakazo/contracts";
import {
  BYOK_TIERS,
  ByokTierSchema,
  SANDBOX_HOURLY_COST_MICROS,
  sandboxAllowanceHours,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { runAsSystemInTransaction } from "./row-security.js";
import { securityEventMetadata, securityRequestCaller } from "./security-events.js";

type Write = Pick<PrismaClient, "$transaction">;

const MB = 1024 * 1024;

/**
 * What an admin set for one plan on the admin page. Null follows the plan's terms in code
 * (`packages/contracts/src/dozo-plans.ts`), which the landing page also shows. Prices are never
 * here: a new price is a new price at the payment provider.
 */
export interface PlanQuota {
  /** The organization's shared space, in MB. */
  sharedSpaceMb: number | null;
  /** The computer hours each month. */
  computerHours: number | null;
}
export type PlanQuotas = Record<ByokTier, PlanQuota>;

/** The audit names of a plan's quotas, in the order the page shows them. */
export const DOZO_PLAN_QUOTA_KEYS = [
  "sharedSpaceMb",
  "computerHours",
] as const satisfies readonly (keyof PlanQuota)[];

/** What the limits are held to: the admin's quota where one is set, else the plan's terms. */
export interface PlanLimits {
  /** Undefined without a limit, as on a build whose plans carry none. */
  sharedSpaceBytes: number | undefined;
  computerAllowanceCents: number;
}
export type PlanLimitsByTier = Record<ByokTier, PlanLimits>;

const UNSET: PlanQuota = { sharedSpaceMb: null, computerHours: null };

/** The plan's terms in code, before any admin quota. */
export function codePlanLimits(tier: ByokTier): PlanLimits {
  const terms: { computerAllowanceCents: number; sharedSpaceBytes?: number } = BYOK_TIERS[tier];
  return {
    sharedSpaceBytes: terms.sharedSpaceBytes,
    computerAllowanceCents: terms.computerAllowanceCents,
  };
}

/** The plan's terms in code, in the units the admin page edits. */
export function codePlanQuota(tier: ByokTier): {
  sharedSpaceMb: number | null;
  computerHours: number;
} {
  const limits = codePlanLimits(tier);
  return {
    sharedSpaceMb: limits.sharedSpaceBytes === undefined ? null : limits.sharedSpaceBytes / MB,
    computerHours: sandboxAllowanceHours(limits.computerAllowanceCents),
  };
}

/** Computer hours as the allowance in cents they count against. */
export function computerHoursCents(hours: number): number {
  return (hours * SANDBOX_HOURLY_COST_MICROS) / 10_000;
}

function limitsOf(tier: ByokTier, quota: PlanQuota): PlanLimits {
  const code = codePlanLimits(tier);
  return {
    sharedSpaceBytes:
      quota.sharedSpaceMb === null ? code.sharedSpaceBytes : quota.sharedSpaceMb * MB,
    computerAllowanceCents:
      quota.computerHours === null
        ? code.computerAllowanceCents
        : computerHoursCents(quota.computerHours),
  };
}

type Row = { tier?: unknown; sharedSpaceMb?: unknown; computerHours?: unknown };

function quotasOf(rows: Row[]): PlanQuotas {
  // A value of another shape follows the plan's terms: never a guess.
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const quotas = Object.fromEntries(
    ByokTierSchema.options.map((tier) => [tier, { ...UNSET }]),
  ) as PlanQuotas;
  for (const row of rows) {
    const tier = ByokTierSchema.safeParse(row.tier).data;
    if (!tier) continue;
    quotas[tier] = {
      sharedSpaceMb: count(row.sharedSpaceMb),
      computerHours: count(row.computerHours),
    };
  }
  return quotas;
}

/**
 * The stored quotas, read from the database on every call: every instance answers from the same
 * rows, so a change holds everywhere at once. A client without the table (a test double of the
 * tables it reads) has no quota to read.
 */
export async function readPlanQuotas(db: object): Promise<PlanQuotas> {
  if (!("dozoPlanQuota" in db)) return quotasOf([]);
  const rows = await (db as Pick<PrismaClient, "dozoPlanQuota">).dozoPlanQuota.findMany({
    select: { tier: true, sharedSpaceMb: true, computerHours: true },
  });
  return quotasOf(rows);
}

/** Every plan's limits as they hold now. The one read the limits are held to. */
export async function readPlanLimits(db: object): Promise<PlanLimitsByTier> {
  const quotas = await readPlanQuotas(db);
  return Object.fromEntries(
    ByokTierSchema.options.map((tier) => [tier, limitsOf(tier, quotas[tier])]),
  ) as PlanLimitsByTier;
}

/**
 * Sets the quotas `change` names for one plan (null returns one to the plan's terms) and answers
 * what they were and are, both read under the row's lock. Each quota that changed is recorded as a
 * `deployment.settings.changed` security event (who, which plan and quota, from and to) in the same
 * transaction. Lowering a quota deletes nothing: files over it stay, only new ones are refused.
 */
export async function changePlanQuota(
  db: Write,
  tier: ByokTier,
  change: { [Key in keyof PlanQuota]?: PlanQuota[Key] | undefined },
  byUserId: string,
): Promise<{ before: PlanQuota; after: PlanQuota }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "dozo_plan_quotas" ("tier", "updatedAt") VALUES (${tier}, CURRENT_TIMESTAMP)
      ON CONFLICT ("tier") DO NOTHING`;
    const rows = await tx.$queryRaw<Row[]>`
      SELECT "tier", "sharedSpaceMb", "computerHours"
      FROM "dozo_plan_quotas" WHERE "tier" = ${tier} FOR UPDATE`;
    const before = quotasOf(rows)[tier];
    // A quota the change leaves out keeps its value.
    const named = Object.entries(change).filter(([, value]) => value !== undefined);
    const after = quotasOf([{ ...before, ...Object.fromEntries(named), tier }])[tier];
    await tx.$executeRaw`
      UPDATE "dozo_plan_quotas" SET
        "sharedSpaceMb" = ${after.sharedSpaceMb},
        "computerHours" = ${after.computerHours},
        "updatedByUserId" = ${byUserId},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "tier" = ${tier}`;
    const caller = securityRequestCaller();
    for (const key of DOZO_PLAN_QUOTA_KEYS) {
      if (before[key] === after[key]) continue;
      // The table is only ever read as system, whoever's request writes it.
      await runAsSystemInTransaction(tx, "record a plan quota change", () =>
        tx.securityEvent.create({
          data: {
            type: "deployment.settings.changed",
            userId: byUserId,
            ip: caller?.ip?.slice(0, 64) ?? null,
            userAgent: caller?.userAgent?.slice(0, 512) ?? null,
            metadata: securityEventMetadata({
              setting: "plan_quota",
              tier,
              quota: key,
              from: before[key],
              to: after[key],
            }),
          },
        }),
      );
    }
    return { before, after };
  });
}
