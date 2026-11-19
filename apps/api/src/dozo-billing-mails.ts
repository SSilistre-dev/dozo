import { randomUUID } from "node:crypto";
import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import type { PlanGrant, Prisma, PrismaClient } from "@rakazo/db";
import { planGrantOf } from "@rakazo/db";

// The tables behind billing's mails (migration 20261227120000_dozo_billing_mails), read and written
// with SQL: they belong to the fork and have no model in schema.prisma.

/** What billing has already told an organization's owners about. */
export type Notice = { pastDueTold: boolean; canceledSubscriptionId: string | null };

export type MailKind = "payment-failed" | "canceled" | "plan-ending";
export type MailDetails = { plan: string; endsAt?: string; next?: string };

/** A mail this process now holds the claim on, with its reader as the account reads today. */
export type ClaimedMail = {
  kind: MailKind;
  details: MailDetails;
  email: string;
  name: string;
  locale: string | null;
  emailVerified: boolean;
  deactivatedAt: Date | null;
};

export type Subscription = {
  status: string | null;
  subscriptionId: string | null;
  byokTier: string | null;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
};

/** Reads and writes inside one transaction. */
export interface BillingTx {
  /** The organization's notice, locked until the transaction ends; a new one has told nothing. */
  lockNotice(organizationId: string): Promise<Notice>;
  saveNotice(organizationId: string, notice: Notice): Promise<void>;
  subscription(organizationId: string): Promise<Subscription | null>;
  grant(organizationId: string): Promise<PlanGrant | null>;
  /** The owners a billing mail goes to: active, with a verified address of their own. */
  owners(organizationId: string): Promise<string[]>;
  /** Records one mail; its id, or null when the owner already has one for `occasion`. */
  addMail(mail: {
    organizationId: string;
    userId: string;
    occasion: string;
    kind: MailKind;
    details: MailDetails;
  }): Promise<string | null>;
  /** Queues a job that commits with the transaction, replacing the one queued under `key`. */
  addJob(task: string, key: string, runAt: Date, payload: object): Promise<void>;
}

export interface BillingMailStore {
  transaction<T>(work: (tx: BillingTx) => Promise<T>): Promise<T>;
  /** The same reads and writes inside a transaction the caller opened. */
  within(tx: Prisma.TransactionClient): BillingTx;
  /** Claims a pending mail no live claim holds; "busy" while one does, null once it is settled. */
  claim(id: string, staleMs: number): Promise<ClaimedMail | "busy" | null>;
  finish(id: string, status: "sent" | "failed" | "skipped"): Promise<void>;
  /** Gives the claim back after a send that may be tried again. */
  release(id: string): Promise<void>;
  removeJob(key: string): Promise<void>;
}

/** Graphile's backoff grows with each try; ten spread a failing job over a few hours. */
const MAX_ATTEMPTS = 10;

/**
 * The store on the database. `jobs` is false where there is no job queue to add to (an in-memory
 * one in tests and local runs): nothing is queued and mails are only sent directly.
 */
export function sqlMailStore(prisma: PrismaClient, { jobs }: { jobs: boolean }): BillingMailStore {
  const within = (tx: Prisma.TransactionClient): BillingTx => ({
    async lockNotice(organizationId) {
      await tx.$executeRaw`
        INSERT INTO "dozo_billing_notices" ("organizationId") VALUES (${organizationId})
        ON CONFLICT ("organizationId") DO NOTHING`;
      const rows = await tx.$queryRaw<Notice[]>`
        SELECT "pastDueTold", "canceledSubscriptionId" FROM "dozo_billing_notices"
        WHERE "organizationId" = ${organizationId} FOR UPDATE`;
      const [notice] = rows;
      if (!notice) throw new Error("The billing notice row was not written");
      return notice;
    },
    async saveNotice(organizationId, notice) {
      await tx.$executeRaw`
        UPDATE "dozo_billing_notices"
        SET "pastDueTold" = ${notice.pastDueTold},
            "canceledSubscriptionId" = ${notice.canceledSubscriptionId},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "organizationId" = ${organizationId}`;
    },
    subscription: (organizationId) =>
      tx.billingAccount.findUnique({
        where: { organizationId },
        select: {
          status: true,
          subscriptionId: true,
          byokTier: true,
          trialEndsAt: true,
          currentPeriodEndsAt: true,
          cancelAtPeriodEnd: true,
        },
      }),
    grant: (organizationId) => planGrantOf(tx, organizationId),
    async owners(organizationId) {
      const members = await tx.member.findMany({
        where: {
          organizationId,
          role: { contains: "owner" },
          user: {
            emailVerified: true,
            deactivatedAt: null,
            // Messaging contacts have a made-up address.
            NOT: { email: { endsWith: MESSAGING_EMAIL_SUFFIX } },
          },
        },
        select: { userId: true },
      });
      return members.map((member) => member.userId);
    },
    async addMail(mail) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "dozo_billing_mails"
          ("id", "organizationId", "userId", "occasion", "kind", "details")
        VALUES (${randomUUID()}, ${mail.organizationId}, ${mail.userId}, ${mail.occasion},
          ${mail.kind}, ${JSON.stringify(mail.details)}::jsonb)
        ON CONFLICT ("userId", "occasion") DO NOTHING
        RETURNING "id"`;
      return rows[0]?.id ?? null;
    },
    async addJob(task, key, runAt, payload) {
      if (!jobs) return;
      // As upstream's publisher adds a job in a transaction; the date goes as text with its zone.
      await tx.$executeRaw`
        SELECT graphile_worker.add_job(${task}::text, ${JSON.stringify(payload)}::json,
          run_at => ${runAt.toISOString()}::timestamptz, max_attempts => ${MAX_ATTEMPTS}::int,
          job_key => ${key}::text)`;
    },
  });

  return {
    transaction: (work) => prisma.$transaction((tx) => work(within(tx))),
    within,
    async claim(id, staleMs) {
      const claimed = await prisma.$queryRaw<ClaimedMail[]>`
        UPDATE "dozo_billing_mails" AS mail SET "claimedAt" = CURRENT_TIMESTAMP
        FROM "user" AS reader
        WHERE mail."id" = ${id} AND reader."id" = mail."userId" AND mail."status" = 'pending'
          AND (mail."claimedAt" IS NULL
            OR mail."claimedAt" < CURRENT_TIMESTAMP - make_interval(secs => ${staleMs / 1000}))
        RETURNING mail."kind", mail."details", reader."email", reader."name", reader."locale",
          reader."emailVerified", reader."deactivatedAt"`;
      if (claimed[0]) return claimed[0];
      const rows = await prisma.$queryRaw<{ status: string }[]>`
        SELECT "status" FROM "dozo_billing_mails" WHERE "id" = ${id}`;
      return rows[0]?.status === "pending" ? "busy" : null;
    },
    async finish(id, status) {
      await prisma.$executeRaw`
        UPDATE "dozo_billing_mails" SET "status" = ${status}, "finishedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${id}`;
    },
    async release(id) {
      await prisma.$executeRaw`
        UPDATE "dozo_billing_mails" SET "claimedAt" = NULL
        WHERE "id" = ${id} AND "status" = 'pending'`;
    },
    async removeJob(key) {
      if (!jobs) return;
      await prisma.$executeRaw`SELECT graphile_worker.remove_job(${key}::text)`;
    },
  };
}
