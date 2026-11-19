import { readFileSync } from "node:fs";
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { BillingEmulator, DozoJobQueue } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createPool } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBillingService } from "./billing.js";
import { createBillingLifecycle } from "./dozo-billing-lifecycle.js";
import { sqlMailStore } from "./dozo-billing-mails.js";

// Runs on the branded tree only, against a migrated database (DATABASE_URL, with the job queue's
// schema): the notice row's lock, the outbox's claim and the migration's seed, in PostgreSQL.
// The fork's unit gate has no database and skips it.

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const SEED = readFileSync(
  new URL(
    "../../../packages/db/prisma/migrations/20261228120000_dozo_billing_mails/migration.sql",
    import.meta.url,
  ),
  "utf8",
).match(/INSERT INTO "dozo_billing_notices"[\s\S]*?;/)?.[0];

describePostgres("billing mails (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizations: string[] = [];
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  /** An organization with one verified owner and the given subscription. */
  async function organization(billing: {
    status: string | null;
    cancelAtPeriodEnd?: boolean;
    customerId?: string;
  }) {
    const id = `billing-mail-${suffix}-${organizations.length}`;
    organizations.push(id);
    await prisma.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Acme", slug: id, createdAt: new Date() },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    const { customerId, ...subscription } = billing;
    await prisma.billingAccount.create({
      data: {
        organizationId: id,
        customerId: customerId ?? `customer-${id}`,
        subscriptionId: customerId ? null : `sub-${id}`,
        byokTier: customerId ? null : "pro",
        currentPeriodEndsAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        ...subscription,
      },
    });
    return id;
  }

  const mails = (organizationId: string) =>
    prisma.$queryRaw<Array<{ id: string; kind: string; status: string }>>`
      SELECT "id", "kind", "status" FROM "dozo_billing_mails"
      WHERE "organizationId" = ${organizationId} ORDER BY "createdAt"`;

  function lifecycle(send = vi.fn(async (_mail: TransactionalEmail) => undefined)) {
    const billing = createBillingLifecycle({
      store: sqlMailStore(prisma, { jobs: true }),
      email: { send, describe: () => ({ id: "test" }) } as never,
      billingUrl: "https://app.example.test/app?settings=billing",
      onError: (error) => {
        throw error;
      },
    });
    return { billing, send };
  }

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    close = async () => {
      await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
      await prisma.user.deleteMany({ where: { id: { in: organizations } } });
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await close();
  });

  it("decides a failed payment once when many syncs run together", async () => {
    const organizationId = await organization({ status: "past_due" });
    const { billing, send } = lifecycle();
    await Promise.all(Array.from({ length: 8 }, () => billing.afterSync(`customer-${organizationId}`)));
    await billing.stop();
    expect(await mails(organizationId)).toEqual([
      expect.objectContaining({ kind: "payment-failed", status: "sent" }),
    ]);
    expect(send).toHaveBeenCalledOnce();
    // The sent mail's backup job is gone.
    const [mail] = await mails(organizationId);
    const jobs = await prisma.$queryRaw<unknown[]>`
      SELECT 1 FROM graphile_worker.jobs WHERE key = ${`dozo.billing-mail:${mail?.id}`}`;
    expect(jobs).toEqual([]);
  });

  it("holds a second decision until the first transaction ends", async () => {
    const organizationId = await organization({ status: "active" });
    const store = sqlMailStore(prisma, { jobs: true });
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const first = store.transaction(async (tx) => {
      await tx.lockNotice(organizationId);
      locked();
      await held;
      await tx.saveNotice(organizationId, { pastDueTold: true, canceledSubscriptionId: null });
      order.push("first");
    });
    await isLocked;
    const second = store.transaction(async (tx) => {
      const notice = await tx.lockNotice(organizationId);
      order.push("second");
      return notice;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual([]);
    release();
    await first;
    // The second reads what the first committed.
    expect(await second).toEqual({ pastDueTold: true, canceledSubscriptionId: null });
    expect(order).toEqual(["first", "second"]);
  });

  it("queues a mail's backup job with the decision, and a stale claim is taken over", async () => {
    const organizationId = await organization({ status: "past_due" });
    const store = sqlMailStore(prisma, { jobs: true });
    const id = await store.transaction(async (tx) => {
      const mail = await tx.addMail({
        organizationId,
        userId: organizationId,
        occasion: "test",
        kind: "payment-failed",
        details: { plan: "Premium" },
      });
      await tx.addJob(
        "dozo.billing-mail",
        `dozo.billing-mail:${mail}`,
        new Date(Date.now() + 360_000),
        {
          mailId: mail,
        },
      );
      return mail;
    });
    if (!id) throw new Error("not recorded");
    const queued = await prisma.$queryRaw<Array<{ task_identifier: string }>>`
      SELECT task_identifier FROM graphile_worker.jobs WHERE key = ${`dozo.billing-mail:${id}`}`;
    expect(queued).toEqual([{ task_identifier: "dozo.billing-mail" }]);
    expect(await store.claim(id, 300_000)).toMatchObject({
      kind: "payment-failed",
      emailVerified: true,
    });
    expect(await store.claim(id, 300_000)).toBe("busy");
    // A claim older than the timeout belongs to a process that died.
    expect(await store.claim(id, 0)).toMatchObject({ kind: "payment-failed" });
    await store.finish(id, "failed");
    expect(await store.claim(id, 0)).toBeNull();
    await store.removeJob(`dozo.billing-mail:${id}`);
  });

  it("runs a job queued in a transaction on a pool of two connections", async () => {
    const organizationId = await organization({ status: "active" });
    const pool = createPool(databaseUrl!, { poolMax: 2, applicationName: "dozo-jobs-test" });
    const ran = vi.fn(async (_payload: unknown) => undefined);
    const queue = new DozoJobQueue(pool, { "dozo.test-task": ran });
    try {
      await sqlMailStore(prisma, { jobs: true }).transaction((tx) =>
        tx.addJob("dozo.test-task", `dozo.test-task:${organizationId}`, new Date(), {
          organizationId,
        }),
      );
      await vi.waitFor(() => expect(ran).toHaveBeenCalledWith({ organizationId }), {
        timeout: 10_000,
      });
    } finally {
      await queue.stop();
      await pool.end();
    }
  });

  it("lets a sync finish every step when its mails fail on a foreign key", async () => {
    const provider = new BillingEmulator({ modelCredits: true });
    const { customerId } = await provider.createCustomer({ email: "a@example.test", organizationId: "x" });
    const organizationId = await organization({ status: null, customerId });
    await prisma.modelCreditAccount.create({ data: { organizationId } });
    provider.byokCheckouts.set(customerId, {
      customerId,
      amountCents: 4900,
      tier: "pro",
      interval: "month",
    } as never);
    provider.completeByokCheckout(customerId);
    const errors: unknown[] = [];
    const store = sqlMailStore(prisma, { jobs: true });
    // The organization is gone by the time the mails are decided: the notice breaks its key.
    const mails = createBillingLifecycle({
      store: { ...store, organizationOf: async () => `gone-${suffix}` },
      email: { send: vi.fn(), describe: () => ({ id: "test" }) } as never,
      billingUrl: "https://app.example.test/app?settings=billing",
      onError: (error) => {
        errors.push(error);
      },
    });
    const billing = createBillingService({
      prisma,
      provider,
      webOrigin: "https://app.example.test",
      dozoAfterSync: mails.afterSync,
    });
    await expect(billing.sync(customerId)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    // The newly paid plan was set up: stored, and made the organization's funding.
    expect(await prisma.billingAccount.findUnique({ where: { organizationId } })).toMatchObject({
      status: "active",
      byokTier: "pro",
    });
    expect(await prisma.modelCreditAccount.findUnique({ where: { organizationId } })).toMatchObject({
      mode: "byok",
    });
  });

  it("finds missing reminders, gives up on abandoned mails and purges settled ones", async () => {
    const organizationId = await organization({ status: "active", cancelAtPeriodEnd: true });
    const store = sqlMailStore(prisma, { jobs: true });
    const prefix = `dozo.plan-ending-test-${suffix}:`;
    expect(await store.reminderGaps(prefix)).toContain(organizationId);
    await store.transaction((tx) => tx.addJob("dozo.test-none", `${prefix}${organizationId}`, new Date(Date.now() + 86_400_000), {}));
    expect(await store.reminderGaps(prefix)).not.toContain(organizationId);
    await prisma.$executeRaw`SELECT graphile_worker.remove_job(${`${prefix}${organizationId}`}::text)`;
    const id = await store.transaction((tx) =>
      tx.addMail({ organizationId, userId: organizationId, occasion: "old", kind: "payment-failed", details: { plan: "Premium" } }),
    );
    await prisma.$executeRaw`UPDATE "dozo_billing_mails" SET "createdAt" = CURRENT_TIMESTAMP - interval '2 days' WHERE "id" = ${id}`;
    expect(await store.failAbandoned(`dozo.billing-mail-test-${suffix}:`, 86_400_000)).toContain(id);
    await prisma.$executeRaw`UPDATE "dozo_billing_mails" SET "finishedAt" = CURRENT_TIMESTAMP - interval '100 days' WHERE "id" = ${id}`;
    expect(await store.purge(90 * 86_400_000)).toBeGreaterThanOrEqual(1);
    expect(await mails(organizationId)).toEqual([]);
  });

  it("counts what was overdue or canceled when it shipped as told", async () => {
    if (!SEED) throw new Error("The migration's seed was not found");
    const overdue = await organization({ status: "past_due" });
    const canceled = await organization({ status: "active", cancelAtPeriodEnd: true });
    const ended = await organization({ status: "canceled", cancelAtPeriodEnd: true });
    // The seed again, for these organizations only, rolled back after.
    const seeded = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM "dozo_billing_notices" WHERE "organizationId" = ANY(${organizations})`;
        await tx.$executeRawUnsafe(SEED);
        const rows = await tx.$queryRaw<
          Array<{
            organizationId: string;
            pastDueTold: boolean;
            canceledSubscriptionId: string | null;
          }>
        >`SELECT "organizationId", "pastDueTold", "canceledSubscriptionId" FROM "dozo_billing_notices"
          WHERE "organizationId" = ANY(${[overdue, canceled, ended]})`;
        throw Object.assign(new Error("rollback"), { rows });
      })
      .catch((error: { rows?: unknown }) => error.rows);
    expect(seeded).toEqual(
      expect.arrayContaining([
        { organizationId: overdue, pastDueTold: true, canceledSubscriptionId: null },
        { organizationId: canceled, pastDueTold: false, canceledSubscriptionId: `sub-${canceled}` },
        { organizationId: ended, pastDueTold: false, canceledSubscriptionId: null },
      ]),
    );
    // Seeded as told, the first sync after mails nothing.
    await prisma.$executeRaw`
      INSERT INTO "dozo_billing_notices" ("organizationId", "pastDueTold", "canceledSubscriptionId")
      VALUES (${canceled}, false, ${`sub-${canceled}`})
      ON CONFLICT ("organizationId") DO UPDATE SET "canceledSubscriptionId" = EXCLUDED."canceledSubscriptionId"`;
    const { billing, send } = lifecycle();
    await billing.afterSync(`customer-${canceled}`);
    await billing.stop();
    expect(send).not.toHaveBeenCalled();
  });
});
