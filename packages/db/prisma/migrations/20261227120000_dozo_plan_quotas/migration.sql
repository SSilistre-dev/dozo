-- Additive: the previous release never reads this table. Quotas an admin sets for each plan at
-- run time, one row per plan. A null column follows the plan's terms in code. Not tenant data, so
-- no row-level policy applies.
CREATE TABLE "dozo_plan_quotas" (
    "tier" TEXT NOT NULL,
    "sharedSpaceMb" INTEGER,
    "computerHours" INTEGER,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dozo_plan_quotas_pkey" PRIMARY KEY ("tier")
);
