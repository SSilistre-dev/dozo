-- Additive: the previous release never reads these tables. Both belong to the fork: they have no
-- model in schema.prisma and are read and written with SQL in packages/db/src/dozo-send-limit.ts.
-- Neither holds content (a number and counts), so no row-level policy applies.

-- How many sends each bot of the account may make in a day without asking. No row means the
-- default (DOZO_DEFAULT_DAILY_SENDS in packages/contracts/src/dozo-send-limit.ts).
CREATE TABLE "dozo_send_limits" (
  "userId" TEXT NOT NULL PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "dailySends" INTEGER NOT NULL CHECK ("dailySends" BETWEEN 1 AND 1000),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Sends one bot made for one member on one day of the member's timezone without asking them.
CREATE TABLE "dozo_daily_sends" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "day" DATE NOT NULL,
  "count" INTEGER NOT NULL CHECK ("count" >= 1),
  PRIMARY KEY ("userId", "botId", "day")
);
CREATE INDEX "dozo_daily_sends_botId_idx" ON "dozo_daily_sends"("botId");
