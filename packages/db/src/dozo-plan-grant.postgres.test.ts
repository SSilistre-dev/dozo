import { BYOK_TIERS, TRIAL_SANDBOX_ALLOWANCE_CENTS } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncBillingSnapshot } from "./billing.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  grantInForce,
  paidTierOf,
  planGrantOf,
  revokePlanGrant,
  setPlanGrant,
  tierInForce,
} from "./dozo-plan-grant.js";
import { SharedSpaceFullError, withSharedSpace } from "./dozo-shared-space.js";
import { asSystem, runAsTenant } from "./row-security.js";
import { planComputerSize, sandboxAllowancePlan } from "./sandbox-allowance.js";

// Runs on the branded tree only, against a migrated database: DATABASE_URL is the runtime login,
// which row security applies to. The fork's unit gate has no database and skips it.

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

describePostgres("a plan granted by hand (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `plan-grant-user-${suffix}`;
  const adminId = `plan-grant-admin-${suffix}`;
  const organizations: string[] = [];
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let close: () => Promise<void>;
  let files = 0;

  /** A new organization with a Space, on its own key and Free unless a subscription is given. */
  async function organization(subscription?: { status: string; byokTier: string }) {
    const id = `plan-grant-org-${suffix}-${organizations.length}`;
    organizations.push(id);
    await owner.organization.create({
      data: { id, name: "Acme", slug: id, createdAt: new Date() },
    });
    const spaceId = `${id}-space`;
    await owner.space.create({ data: { id: spaceId, organizationId: id, name: spaceId } });
    await owner.modelCreditAccount.create({ data: { organizationId: id, mode: "byok" } });
    if (subscription)
      await owner.billingAccount.create({
        data: {
          organizationId: id,
          customerId: `customer-${id}`,
          byokPriceCents: 1000,
          ...subscription,
        },
      });
    return { id, spaceId, customerId: `customer-${id}` };
  }

  const grant = (organizationId: string, tier: "pro" | "max", days: number, note?: string) =>
    setPlanGrant(owner, {
      organizationId,
      tier,
      endsAt: new Date(Date.now() + days * DAY),
      grantedById: adminId,
      note,
    });

  /** What a request of the Space's own member reads: the computer allowance and the machine size. */
  const asMember =
    (spaceId: string) =>
    <T>(read: () => Promise<T>) =>
      runAsTenant({ spaceId, userId }, read);
  const allowance = (org: { id: string; spaceId: string }) =>
    asMember(org.spaceId)(async () => (await sandboxAllowancePlan(prisma, org.id))?.limitCents);
  const size = (org: { spaceId: string }) =>
    asMember(org.spaceId)(() => planComputerSize(prisma, org.spaceId));

  const subscription = (tier: "pro" | "max" | null) =>
    tier
      ? {
          subscriptionId: "sub",
          subscriptionItemId: "item",
          priceId: "price",
          status: "active" as const,
          seats: 1,
          trialEndsAt: null,
          currentPeriodStartsAt: new Date(Date.now() - DAY),
          currentPeriodEndsAt: new Date(Date.now() + 29 * DAY),
          cancelAtPeriodEnd: false,
          endedAt: null,
          byokPlan: true,
          byokPriceCents: 1000,
          byokInterval: "month" as const,
          byokTier: tier,
        }
      : null;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    owner = asSystem(db.prisma);
    const before = await owner.deploymentSettings.findUnique({ where: { id: "default" } });
    await owner.user.createMany({
      data: [userId, adminId].map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    });
    close = async () => {
      await owner.organization.deleteMany({ where: { id: { in: organizations } } });
      await owner.user.deleteMany({ where: { id: { in: [userId, adminId] } } });
      await owner.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", modelCreditsEnabled: before?.modelCreditsEnabled ?? false },
        update: { modelCreditsEnabled: before?.modelCreditsEnabled ?? false },
      });
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await owner.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", modelCreditsEnabled: true },
      update: { modelCreditsEnabled: true },
    });
  });

  afterAll(async () => {
    await close();
  });

  it("is read by a member's own request, which row security would otherwise empty", async () => {
    const org = await organization();
    expect(await allowance(org)).toBe(0);
    await grant(org.id, "pro", 3);
    expect(await allowance(org)).toBe(BYOK_TIERS.pro.computerAllowanceCents);
    expect(await size(org)).toBe(BYOK_TIERS.pro.computerSize);
    await grant(org.id, "max", 3);
    expect(await allowance(org)).toBe(BYOK_TIERS.max.computerAllowanceCents);
  });

  it("ends at its date and when taken back: no computer, the first plan's size", async () => {
    const org = await organization();
    await grant(org.id, "max", 3);
    expect(await allowance(org)).toBe(BYOK_TIERS.max.computerAllowanceCents);
    await owner.dozoPlanGrant.update({
      where: { organizationId: org.id },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
    expect(await allowance(org)).toBe(0);
    expect(await size(org)).toBe("standard");
    await grant(org.id, "pro", 3);
    expect(await allowance(org)).toBe(BYOK_TIERS.pro.computerAllowanceCents);
    await expect(revokePlanGrant(owner, org.id)).resolves.toBe(true);
    expect(await allowance(org)).toBe(0);
    await expect(revokePlanGrant(owner, org.id)).resolves.toBe(false);
  });

  it("is left in place by a subscription sync, and carries the plan when the subscription ends", async () => {
    const org = await organization({ status: "active", byokTier: "pro" });
    await grant(org.id, "max", 10, "press");
    const stored = await owner.dozoPlanGrant.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    const inForce = async () => {
      const row = await owner.organization.findUniqueOrThrow({
        where: { id: org.id },
        select: { billing: true, dozoPlanGrant: true },
      });
      return tierInForce(paidTierOf(row.billing), row.dozoPlanGrant);
    };
    expect(await inForce()).toBe("max");

    // A webhook delivering the same subscription, a change of tier, and the subscription ending.
    for (const tier of ["pro", "max", null] as const) {
      await syncBillingSnapshot(owner, org.customerId, async () => subscription(tier));
      await expect(
        owner.dozoPlanGrant.findUniqueOrThrow({ where: { organizationId: org.id } }),
      ).resolves.toEqual(stored);
      expect(await inForce()).toBe("max");
    }
    // The subscription is gone and the grant still gives its plan.
    expect(await allowance(org)).toBe(BYOK_TIERS.max.computerAllowanceCents);

    await owner.dozoPlanGrant.update({
      where: { organizationId: org.id },
      data: { tier: "pro" },
    });
    expect(await inForce()).toBe("pro");
    await syncBillingSnapshot(owner, org.customerId, async () => subscription("max"));
    expect(await inForce()).toBe("max");
    expect(await allowance(org)).toBe(BYOK_TIERS.max.computerAllowanceCents);
  });

  it("raises a trial's allowance, a cancelled trial's too, and does not lower a credit plan's", async () => {
    const trial = await organization({ status: "trialing", byokTier: "pro" });
    expect(await allowance(trial)).toBe(TRIAL_SANDBOX_ALLOWANCE_CENTS);
    await grant(trial.id, "max", 3);
    expect(await allowance(trial)).toBe(
      Math.max(TRIAL_SANDBOX_ALLOWANCE_CENTS, BYOK_TIERS.max.computerAllowanceCents),
    );
    await revokePlanGrant(owner, trial.id);
    await owner.billingAccount.update({
      where: { organizationId: trial.id },
      data: { cancelAtPeriodEnd: true },
    });
    expect(await allowance(trial)).toBe(0);
    await grant(trial.id, "pro", 3);
    expect(await allowance(trial)).toBe(BYOK_TIERS.pro.computerAllowanceCents);

    const monthly = await organization({ status: "active", byokTier: "pro" });
    await owner.billingAccount.update({
      where: { organizationId: monthly.id },
      data: { byokTier: null, byokPriceCents: null, creditAmountCents: 1_000_000 },
    });
    await owner.modelCreditAccount.update({
      where: { organizationId: monthly.id },
      data: { mode: "credits" },
    });
    const before = await allowance(monthly);
    expect(before).toBeGreaterThan(BYOK_TIERS.max.computerAllowanceCents);
    await grant(monthly.id, "max", 3);
    expect(await allowance(monthly)).toBe(before);
  });

  it("gives the shared space of the plan in force", async () => {
    const org = await organization();
    const add = (bytes: number) =>
      runAsTenant({ spaceId: org.spaceId, userId }, () =>
        withSharedSpace(prisma, org.spaceId, (tx) =>
          tx.artifact.create({
            data: {
              spaceId: org.spaceId,
              userId,
              name: `file-${files}`,
              mimeType: "text/plain",
              size: bytes,
              hash: "hash",
              storageKey: `plan-grant-${suffix}-${files++}`,
            },
          }),
        ),
      );
    await add(400 * MB);
    await expect(add(200 * MB)).rejects.toBeInstanceOf(SharedSpaceFullError);
    await grant(org.id, "pro", 3);
    await expect(add(200 * MB)).resolves.toBeDefined();
    await revokePlanGrant(owner, org.id);
    await expect(add(1)).rejects.toBeInstanceOf(SharedSpaceFullError);
  });

  it("is replaced by a new grant, one row per organization", async () => {
    const org = await organization();
    await grant(org.id, "pro", 3, "first");
    await grant(org.id, "max", 9);
    expect(await owner.dozoPlanGrant.count({ where: { organizationId: org.id } })).toBe(1);
    const row = await owner.dozoPlanGrant.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(row).toMatchObject({ tier: "max", grantedById: adminId, note: null });
    expect(grantInForce(await planGrantOf(owner, org.id))?.tier).toBe("max");
  });

  it("goes with its organization, and loses only the name of an admin whose account goes", async () => {
    const org = await organization();
    await grant(org.id, "pro", 3);
    await owner.user.create({
      data: {
        id: `${adminId}-gone`,
        name: "Gone",
        email: `${adminId}-gone@example.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await owner.dozoPlanGrant.update({
      where: { organizationId: org.id },
      data: { grantedById: `${adminId}-gone` },
    });
    await owner.user.delete({ where: { id: `${adminId}-gone` } });
    await expect(
      owner.dozoPlanGrant.findUniqueOrThrow({ where: { organizationId: org.id } }),
    ).resolves.toMatchObject({ tier: "pro", grantedById: null });
    await owner.organization.delete({ where: { id: org.id } });
    expect(await owner.dozoPlanGrant.count({ where: { organizationId: org.id } })).toBe(0);
  });
});
