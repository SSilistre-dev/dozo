-- Additive: the previous release never reads these tables. Both belong to the fork and, like
-- dozo_site_settings and dozo_bans, have no model in schema.prisma: every read and write here
-- needs SQL anyway (a row lock, an insert that returns only what was new, the job queue's
-- functions in the same transaction), so a model would only add an upstream schema rule. They are
-- read in apps/api/src/dozo-billing-mails.ts. Like billing_accounts they have no row-level policy:
-- only system work reads or writes them.

-- What billing has already told an organization's owners about, so a mail goes out once per
-- occasion: a payment that is overdue, and the subscription that was set to cancel.
CREATE TABLE "dozo_billing_notices" (
    "organizationId" TEXT NOT NULL,
    "pastDueTold" BOOLEAN NOT NULL DEFAULT false,
    "canceledSubscriptionId" TEXT,
    -- When the hourly sweep last looked for the organization's missing reminder: it starts from
    -- the longest ago, so organizations that never need one cannot crowd out those that do.
    "reminderCheckedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dozo_billing_notices_pkey" PRIMARY KEY ("organizationId")
);

ALTER TABLE "dozo_billing_notices" ADD CONSTRAINT "dozo_billing_notices_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Whatever is overdue or canceled when this ships counts as told: only what changes afterwards
-- is mailed, so nobody who canceled months ago is sent a confirmation now.
INSERT INTO "dozo_billing_notices" ("organizationId", "pastDueTold", "canceledSubscriptionId")
SELECT
    "organizationId",
    -- A customer that never subscribed has no status, which counts as nothing overdue.
    COALESCE("status" IN ('past_due', 'unpaid'), false),
    CASE
        WHEN "cancelAtPeriodEnd" AND "status" IN ('trialing', 'active', 'past_due')
        THEN "subscriptionId"
    END
FROM "billing_accounts";

-- One billing mail to one owner. "occasion" names what it is about; the unique pair keeps it to
-- one mail per owner and occasion. A send claims the row first ("claimedAt"); a claim older than
-- the claim timeout is taken over, since its process may have died.
CREATE TABLE "dozo_billing_mails" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occasion" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dozo_billing_mails_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dozo_billing_mails_userId_occasion_key" ON "dozo_billing_mails"("userId", "occasion");

CREATE INDEX "dozo_billing_mails_organizationId_idx" ON "dozo_billing_mails"("organizationId");

ALTER TABLE "dozo_billing_mails" ADD CONSTRAINT "dozo_billing_mails_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dozo_billing_mails" ADD CONSTRAINT "dozo_billing_mails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
