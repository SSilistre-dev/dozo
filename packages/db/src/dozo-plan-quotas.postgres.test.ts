import { BYOK_TIERS } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { changePlanQuota, computerHoursCents, readPlanLimits } from "./dozo-plan-quotas.js";
import { asSystem, runAsSystemInTransaction } from "./row-security.js";

// Runs on the branded tree only, against a migrated database: DATABASE_URL is the runtime login,
// which row security applies to. The fork's unit gate has no database and skips it.

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const MB = 1024 * 1024;

class RolledBack extends Error {}

describePostgres("plan quotas (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await close();
  });

  /**
   * Runs the test in one transaction that is rolled back at the end: quotas are deployment-wide,
   * and the other PostgreSQL tests read the plans' terms at the same time.
   */
  async function inRolledBack(test: (tx: Prisma.TransactionClient) => Promise<void>) {
    await expect(
      asSystem(prisma).$transaction(async (tx) => {
        await test(tx);
        throw new RolledBack();
      }),
    ).rejects.toBeInstanceOf(RolledBack);
  }
  const within = (tx: Prisma.TransactionClient) =>
    ({ $transaction: (work: (client: unknown) => unknown) => work(tx) }) as unknown as Pick<
      PrismaClient,
      "$transaction"
    >;

  it("writes, locks and reads a plan's quotas, each change audited with it", async () => {
    await inRolledBack(async (tx) => {
      const adminId = `plan-quota-admin-${process.pid}-${Date.now()}`;
      await tx.user.create({
        data: {
          id: adminId,
          name: adminId,
          email: `${adminId}@example.test`,
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      // The row is created by the first change (the insert that does nothing when it exists).
      await changePlanQuota(within(tx), "pro", { sharedSpaceMb: 300 }, adminId);
      const { before, after } = await changePlanQuota(
        within(tx),
        "pro",
        { computerHours: 9 },
        adminId,
      );
      expect(before).toEqual({ sharedSpaceMb: 300, computerHours: null });
      expect(after).toEqual({ sharedSpaceMb: 300, computerHours: 9 });

      const limits = await readPlanLimits(tx);
      expect(limits.pro).toEqual({
        sharedSpaceBytes: 300 * MB,
        computerAllowanceCents: computerHoursCents(9),
      });
      expect(limits.max.computerAllowanceCents).toBe(BYOK_TIERS.max.computerAllowanceCents);

      const events = await runAsSystemInTransaction(tx, "read the test's audit", () =>
        tx.securityEvent.findMany({
          where: { userId: adminId, type: "deployment.settings.changed" },
          orderBy: { createdAt: "asc" },
          select: { metadata: true },
        }),
      );
      expect(events.map((event) => event.metadata)).toEqual([
        { setting: "plan_quota", tier: "pro", quota: "sharedSpaceMb", from: null, to: 300 },
        { setting: "plan_quota", tier: "pro", quota: "computerHours", from: null, to: 9 },
      ]);
    });
  });

  it("never gives Free hours or follows a value out of bounds written by hand", async () => {
    await inRolledBack(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "dozo_plan_quotas" ("tier", "sharedSpaceMb", "computerHours", "updatedAt")
        VALUES ('standard', 100, 40, CURRENT_TIMESTAMP), ('max', -5, 0, CURRENT_TIMESTAMP)
        ON CONFLICT ("tier") DO UPDATE SET
          "sharedSpaceMb" = EXCLUDED."sharedSpaceMb",
          "computerHours" = EXCLUDED."computerHours"`;
      const limits = await readPlanLimits(tx);
      expect(limits.standard).toEqual({ sharedSpaceBytes: 100 * MB, computerAllowanceCents: 0 });
      expect(limits.max).toEqual({
        sharedSpaceBytes: 5 * 1024 * MB,
        computerAllowanceCents: BYOK_TIERS.max.computerAllowanceCents,
      });
    });
  });
});
