-- Additive: the previous release never reads this column. How many computers one person may have in
-- use on a plan, set by an admin at run time. Null follows the plan's terms in code.
ALTER TABLE "dozo_plan_quotas" ADD COLUMN "computers" INTEGER;
