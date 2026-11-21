-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in packages/adapters/src/dozo-daily-digest.ts.
-- It holds no content (two ids), so no row-level policy applies.

-- An account's daily digest: the routine that writes it. The routine holds the bot, the Space and
-- the time; deleting it (from the Routines list or with its bot) turns the digest off.
CREATE TABLE "dozo_daily_digest" (
  "userId" TEXT NOT NULL PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "routineId" TEXT NOT NULL UNIQUE REFERENCES "routines"("id") ON DELETE CASCADE
);
