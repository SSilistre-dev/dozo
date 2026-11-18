-- Additive: the previous release never reads this table. An entry names an address or a domain
-- the operator refuses, not tenant data, so no row-level policy applies. The table belongs to the
-- fork: it has no model in schema.prisma and is read with SQL in packages/auth/src/dozo-operator.ts.
CREATE TABLE "dozo_bans" (
  "value" TEXT NOT NULL PRIMARY KEY,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
