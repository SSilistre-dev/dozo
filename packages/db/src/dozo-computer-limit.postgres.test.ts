import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./database/client.js";
import { createDb } from "./database/client.js";
import { assertOwnComputerAllowed, computerLimitFor } from "./dozo-computer-limit.js";
import { setPlanGrant } from "./dozo-plan-grant.js";
import { asSystem, runAsTenant } from "./database/row-security.js";

// Runs on the branded tree only, against a migrated database: DATABASE_URL is the runtime login,
// which row security applies to. The fork's unit gate has no database and skips it.

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("computers a plan allows (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `computer-limit-user-${suffix}`;
  const organizations: string[] = [];
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let close: () => Promise<void>;

  /** An organization with one Space and a computer in it, on Free unless a tier is given. */
  async function organization(tier?: string) {
    const id = `computer-limit-org-${suffix}-${organizations.length}`;
    organizations.push(id);
    await owner.organization.create({
      data: { id, name: "Acme", slug: id, createdAt: new Date() },
    });
    const spaceId = `${id}-s`;
    await owner.space.create({ data: { id: spaceId, organizationId: id, name: spaceId } });
    const computer = await owner.computer.create({
      data: {
        spaceId,
        userId,
        kind: "docker",
        scopeKey: `team:${spaceId}`,
        homeKey: `home-${spaceId}`,
      },
    });
    if (tier)
      await owner.billingAccount.create({
        data: { organizationId: id, customerId: `customer-${id}`, status: "active", byokTier: tier },
      });
    return { id, spaceId, computerId: computer.id };
  }

  /** What a member of the Space reads: the login row security applies to. */
  const asMember = <T>(spaceId: string, work: () => Promise<T>) =>
    runAsTenant({ spaceId, userId }, work);

  const bills = (modelCreditsEnabled: boolean) =>
    owner.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", modelCreditsEnabled },
      update: { modelCreditsEnabled },
    });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    owner = asSystem(db.prisma);
    const before = await owner.deploymentSettings.findUnique({ where: { id: "default" } });
    close = async () => {
      await owner.organization.deleteMany({ where: { id: { in: organizations } } });
      await owner.user.deleteMany({ where: { id: userId } });
      await bills(before?.modelCreditsEnabled ?? false);
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await owner.user.create({
      data: {
        id: userId,
        name: userId,
        email: `${userId}@example.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await bills(true);
  });

  afterAll(async () => {
    await close();
  });

  it("runs as a login row security applies to", async () => {
    const [role] = await prisma.$queryRaw<Array<{ free: boolean }>>`
      SELECT (r.rolsuper OR r.rolbypassrls) AS "free" FROM pg_roles r WHERE r.rolname = session_user`;
    expect(role?.free).toBe(false);
  });

  it("reads the organization's bill as its member: one on Premium, three on Premium Plus", async () => {
    // A bill the member could not see would fall back to the environment's limit, quietly: here
    // the environment says nothing and the answers are the plans' own.
    delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
    const premium = await organization("pro");
    const plus = await organization("max");
    expect(await asMember(premium.spaceId, () => computerLimitFor(prisma, premium))).toBe(1);
    expect(await asMember(plus.spaceId, () => computerLimitFor(prisma, plus))).toBe(3);
  });

  it("finds the plan from a computer alone, as a restore does", async () => {
    delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
    const plus = await organization("max");
    expect(
      await asMember(plus.spaceId, () => computerLimitFor(prisma, { computerId: plus.computerId })),
    ).toBe(3);
  });

  it("reads a plan an admin granted, until it ends", async () => {
    delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
    const org = await organization();
    const day = 24 * 60 * 60 * 1000;
    await setPlanGrant(owner, {
      organizationId: org.id,
      tier: "max",
      endsAt: new Date(Date.now() + day),
      grantedById: userId,
    });
    expect(await asMember(org.spaceId, () => computerLimitFor(prisma, org))).toBe(3);
    await setPlanGrant(owner, {
      organizationId: org.id,
      tier: "max",
      endsAt: new Date(Date.now() - day),
      grantedById: userId,
    });
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "4";
    expect(await asMember(org.spaceId, () => computerLimitFor(prisma, org))).toBe(4);
    delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
  });

  it("leaves Free to the environment, and a server that does not bill to it too", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "5";
    try {
      const free = await organization();
      expect(await asMember(free.spaceId, () => computerLimitFor(prisma, free))).toBe(5);
      const premium = await organization("pro");
      await bills(false);
      expect(await asMember(premium.spaceId, () => computerLimitFor(prisma, premium))).toBe(5);
      await bills(true);
      expect(await asMember(premium.spaceId, () => computerLimitFor(prisma, premium))).toBe(1);
    } finally {
      delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
    }
  });

  it("refuses a bot's own computer on Premium only", async () => {
    const premium = await organization("pro");
    const plus = await organization("max");
    await expect(
      asMember(premium.spaceId, () =>
        assertOwnComputerAllowed(prisma, { mode: "dedicated", spaceId: premium.spaceId }),
      ),
    ).rejects.toMatchObject({ code: "computer_limit_shared" });
    await expect(
      asMember(plus.spaceId, () =>
        assertOwnComputerAllowed(prisma, { mode: "dedicated", spaceId: plus.spaceId }),
      ),
    ).resolves.toBeUndefined();
  });
});
