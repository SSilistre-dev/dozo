-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in packages/adapters/src/dozo-spoken-briefing.ts
-- and apps/api/src/dozo-spoken-briefings.ts.

-- A routine whose runs end with a spoken briefing, and the bot that co-hosts it with the
-- routine's own bot. Deleting the routine or the co-host turns the briefing off. "day" (UTC) and
-- "spoken" count the briefings taken that day, which a small daily cap bounds.
CREATE TABLE "dozo_spoken_briefings" (
  "routineId" TEXT PRIMARY KEY REFERENCES "routines"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "coHostBotId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "day" DATE,
  "spoken" INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX "dozo_spoken_briefings_coHostBotId_idx" ON "dozo_spoken_briefings"("coHostBotId");
CREATE INDEX "dozo_spoken_briefings_spaceId_idx" ON "dozo_spoken_briefings"("spaceId");

-- A Space's rows, as for its routines.
ALTER TABLE "dozo_spoken_briefings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_spoken_briefings_tenant ON "dozo_spoken_briefings"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_spoken_briefings_system ON "dozo_spoken_briefings"
  USING ((SELECT app_rls_bypass()));
