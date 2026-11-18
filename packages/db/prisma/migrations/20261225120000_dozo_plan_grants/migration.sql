-- Additive: the previous release never reads this table. A plan an admin gave an organization by
-- hand, kept apart from billing_accounts so a subscription sync never overwrites it. Like
-- billing_accounts it has no row-level policy: the plan in force is read inside a tenant's own
-- requests and uploads, and no tenant-facing route writes it.
CREATE TABLE "dozo_plan_grants" (
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "grantedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dozo_plan_grants_pkey" PRIMARY KEY ("organizationId")
);

ALTER TABLE "dozo_plan_grants" ADD CONSTRAINT "dozo_plan_grants_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dozo_plan_grants" ADD CONSTRAINT "dozo_plan_grants_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
