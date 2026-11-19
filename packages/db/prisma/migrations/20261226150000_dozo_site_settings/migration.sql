-- Additive: the previous release never reads this table. Site settings an admin changes at run
-- time, one row. A null column follows the environment variable that set it before. Not tenant
-- data, so no row-level policy applies. The table belongs to the fork: it has no model in
-- schema.prisma and is read with SQL in packages/db/src/dozo-site-settings.ts.
CREATE TABLE "dozo_site_settings" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default' CHECK ("id" = 'default'),
  "signupsOpen" BOOLEAN,
  "maxComputersPerUser" INTEGER CHECK ("maxComputersPerUser" >= 0),
  "announcementEn" TEXT,
  "announcementTr" TEXT,
  "updatedByUserId" TEXT,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
