import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { resolveMaxComputersPerUser } from "./computers.js";
import { DOZO_PLAN_GRANT_SELECT, paidTierOf, tierInForce } from "./dozo-plan-grant.js";
import { readPlanLimits } from "./dozo-plan-quotas.js";
import { readSiteSettings } from "./dozo-site-settings.js";
import { runAsSystemInTransaction } from "./row-security.js";

/** What a client switches on: the user's computers are shared Team Computers, so archiving frees none. */
export const SHARED_COMPUTER_LIMIT_CODE = "computer_limit_shared";

export class SharedComputerLimitError extends ClientError {
  constructor(limit: number) {
    super("BAD_REQUEST", `User computer limit (${limit}) reached`, SHARED_COMPUTER_LIMIT_CODE);
    this.name = "SharedComputerLimitError";
  }
}

/**
 * The refusal for a bot that asked for a computer of its own at the limit. When every computer
 * the person has in use is a shared Team Computer, archiving a bot frees nothing: the bot can use
 * the Team Computer instead. Otherwise `fallback`, whose advice (archive a bot) frees a computer.
 */
export async function computerLimitRefusal(
  tx: Pick<PrismaClient, "computer" | "$queryRaw">,
  input: { mode: string; userId: string; botId?: string },
  limit: number,
  fallback: ClientError,
): Promise<ClientError> {
  if (input.mode !== "dedicated") return fallback;
  const reason = "computer quota across the user's Spaces";
  const own = await runAsSystemInTransaction(tx, reason, () =>
    tx.computer.count({
      where: {
        userId: input.userId,
        scope: { not: "team" },
        bots: {
          some: input.botId
            ? { archivedAt: null, id: { not: input.botId } }
            : { archivedAt: null },
        },
      },
    }),
  );
  return own === 0 ? new SharedComputerLimitError(limit) : fallback;
}

type PlanReads = Pick<
  PrismaClient,
  "$queryRaw" | "computer" | "space" | "deploymentSettings" | "dozoPlanQuota"
>;

/** The computers the plan in force for a Space allows one person, or undefined where it counts none. */
async function planComputers(
  db: PlanReads,
  where: { spaceId?: string | undefined; computerId?: string | undefined },
): Promise<number | undefined> {
  const settings = await db.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { modelCreditsEnabled: true },
  });
  // A server that does not bill has no plans.
  if (settings?.modelCreditsEnabled !== true) return undefined;
  const spaceId =
    where.spaceId ??
    (where.computerId
      ? (
          await db.computer.findUnique({
            where: { id: where.computerId },
            select: { spaceId: true },
          })
        )?.spaceId
      : undefined);
  if (!spaceId) return undefined;
  const space = await db.space.findUnique({
    where: { id: spaceId },
    select: {
      organization: {
        select: {
          billing: { select: { status: true, byokTier: true } },
          dozoPlanGrant: { select: DOZO_PLAN_GRANT_SELECT },
        },
      },
    },
  });
  if (!space) return undefined;
  const tier =
    tierInForce(paidTierOf(space.organization.billing), space.organization.dozoPlanGrant) ??
    "standard";
  return (await readPlanLimits(db))[tier].computers;
}

/**
 * Computers one person may have in use across their Spaces, or 0 for no cap. The plan in force for
 * the Space sets it (Premium one, Premium Plus three). An admin's site limit stays an upper bound
 * on it; `SANDBOX_MAX_COMPUTERS_PER_USER` applies only where the plan counts none: Free, a server
 * that does not bill, or a build without plans. A client that cannot run SQL (a test double of the
 * computer table) has neither plan nor admin setting to read.
 */
export async function computerLimitFor(
  db: object,
  where: { spaceId?: string | undefined; computerId?: string | undefined },
): Promise<number> {
  const reads = db as Partial<PlanReads>;
  if (typeof reads.$queryRaw !== "function") return resolveMaxComputersPerUser();
  const admin = (await readSiteSettings(reads as Pick<PrismaClient, "$queryRaw">))
    .maxComputersPerUser;
  const plan =
    reads.deploymentSettings && reads.space && reads.computer && reads.dozoPlanQuota
      ? await planComputers(reads as PlanReads, where)
      : undefined;
  if (plan === undefined) return admin ?? resolveMaxComputersPerUser();
  return admin ? Math.min(plan, admin) : plan;
}
