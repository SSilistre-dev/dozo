-- Additive: the previous release never reads this table.
--
-- Who last created or changed each routine (ROUTINE_WRITERS in
-- packages/core/src/dozo-lasting-write-approval.ts). A routine's runs take its prompt as the owner's
-- words for skill and routine writes only when the owner last wrote it; a routine without a row
-- does not count as theirs. The table belongs to the fork: it has no model in schema.prisma and is
-- read and written with SQL in packages/db/src/dozo-routine-writers.ts.
CREATE TABLE "dozo_routine_writers" (
  "routineId" TEXT PRIMARY KEY REFERENCES "routines"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "writer" TEXT NOT NULL CHECK ("writer" IN ('owner', 'owner_run', 'member', 'outside_run')),
  "writtenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "dozo_routine_writers_spaceId_idx" ON "dozo_routine_writers"("spaceId");

-- Shared by the members of the routine's Space, as the routine is.
ALTER TABLE "dozo_routine_writers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_routine_writers_tenant ON "dozo_routine_writers"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_routine_writers_system ON "dozo_routine_writers"
  USING ((SELECT app_rls_bypass()));
