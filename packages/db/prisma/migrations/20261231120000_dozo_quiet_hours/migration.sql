-- Additive: the previous release never reads these tables. Both belong to the fork: they have no
-- model in schema.prisma and are read and written with SQL in
-- packages/adapters/src/dozo-quiet-hours.ts. Neither holds content (only minutes of the day and
-- times), so no row-level policy applies.

-- An account's quiet hours: one daily range of local minutes in which its routines start nothing.
-- The range ends at "endMinute" (not included) and crosses midnight when that is the smaller one.
CREATE TABLE "dozo_quiet_hours" (
  "userId" TEXT NOT NULL PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "startMinute" INTEGER NOT NULL CHECK ("startMinute" BETWEEN 0 AND 1439),
  "endMinute" INTEGER NOT NULL CHECK ("endMinute" BETWEEN 0 AND 1439),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("startMinute" <> "endMinute")
);

-- A routine occurrence waiting for quiet hours to end: when it was due, and the wake that takes it
-- up again. Only a routine whose next run is still "heldUntil" is waiting; an edit ends the wait.
CREATE TABLE "dozo_routine_holds" (
  "routineId" TEXT NOT NULL PRIMARY KEY REFERENCES "routines"("id") ON DELETE CASCADE,
  "dueAt" TIMESTAMPTZ(3) NOT NULL,
  "heldUntil" TIMESTAMPTZ(3) NOT NULL
);
