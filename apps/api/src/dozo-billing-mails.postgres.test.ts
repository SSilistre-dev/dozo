import { readFileSync } from "node:fs";
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { DozoJobQueue } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createPool } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBillingLifecycle } from "./dozo-billing-lifecycle.js";
import { sqlMailStore } from "./dozo-billing-mails.js";

// Runs on the branded tree only, against a migrated database (DATABASE_URL, with the job queue's
// schema): the notice row's lock, the outbox's claim and the migration's seed, in PostgreSQL.
// The fork's unit gate has no database and skips it.

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const SEED = readFileSync(
  new URL(
    "../../../packages/db/prisma/migrations/20261227120000_dozo_billing_mails/migration.sql",
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
  async function organization(billing: { status: string; cancelAtPeriodEnd?: boolean }) {
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
    await prisma.billingAccount.create({
      data: {
        organizationId: id,
        customerId: `customer-${id}`,
        subscriptionId: `sub-${id}`,
        byokTier: "pro",
        currentPeriodEndsAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        ...billing,
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
    await Promise.all(Array.from({ length: 8 }, () => billing.afterSync(organizationId)));
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
    await billing.afterSync(canceled);
    await billing.stop();
    expect(send).not.toHaveBeenCalled();
  });
});
