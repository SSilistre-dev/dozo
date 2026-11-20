-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in packages/adapters/src/dozo-wait.ts. It
-- holds no content (only a time and a number of minutes), so no row-level policy applies.

-- A watching routine that is a one-time wait: it wakes its bot once, at the first change or at
-- "endsAt", then ends. "minutes" is the wait the bot asked for, told back to it at the deadline.
CREATE TABLE "dozo_routine_waits" (
  "routineId" TEXT NOT NULL PRIMARY KEY REFERENCES "routines"("id") ON DELETE CASCADE,
  "endsAt" TIMESTAMPTZ(3) NOT NULL,
  "minutes" INTEGER NOT NULL CHECK ("minutes" > 0)
);
