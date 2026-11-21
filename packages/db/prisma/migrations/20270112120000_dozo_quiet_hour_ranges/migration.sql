-- Additive: the previous release never reads this table. It belongs to the fork: it has no model in
-- schema.prisma and is read and written with SQL in packages/adapters/src/dozo-quiet-hours.ts. It
-- holds only minutes of the day and days of the week, so no row-level policy applies.

-- An account's quiet hours as up to four ranges, their union in force. Each range ends at
-- "endMinute" (not included), crosses midnight when that is the smaller one, and belongs to the
-- day it starts on: "days" is a 7-bit mask, Monday bit 0 to Sunday bit 6. dozo_quiet_hours keeps
-- the first range's times while the previous release may still read it.
CREATE TABLE "dozo_quiet_hour_ranges" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "position" SMALLINT NOT NULL CHECK ("position" BETWEEN 0 AND 3),
  "startMinute" INTEGER NOT NULL CHECK ("startMinute" BETWEEN 0 AND 1439),
  "endMinute" INTEGER NOT NULL CHECK ("endMinute" BETWEEN 0 AND 1439),
  "days" SMALLINT NOT NULL CHECK ("days" BETWEEN 1 AND 127),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("startMinute" <> "endMinute"),
  PRIMARY KEY ("userId", "position")
);
