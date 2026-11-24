-- deferred
-- The fork no longer sells plans: no code reads or writes these tables any more. They are the plans an
-- admin gave by hand, the quotas an admin set for each plan, and what the billing mails had already
-- told an organization's owners. The earlier migrations that created them stay as they are.
DROP TABLE IF EXISTS "dozo_billing_mails";
DROP TABLE IF EXISTS "dozo_billing_notices";
DROP TABLE IF EXISTS "dozo_plan_quotas";
DROP TABLE IF EXISTS "dozo_plan_grants";
