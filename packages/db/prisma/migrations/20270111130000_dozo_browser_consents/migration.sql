-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in packages/adapters/src/dozo-user-browser.ts.

-- What the person allowed one bot to do with its own browser on one of their computers: use it at
-- all (site ''), and act on a site (its registrable domain, such as "example.com"). Written when a
-- call they approved runs. Deleting the bot or removing the computer takes its rows, so pairing
-- again asks again. Like user_devices, only the server reads it, for the device's own owner, so it
-- has no row policy.
CREATE TABLE "dozo_browser_consents" (
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "deviceId" TEXT NOT NULL REFERENCES "user_devices"("id") ON DELETE CASCADE,
  "site" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("botId", "deviceId", "site")
);
CREATE INDEX "dozo_browser_consents_deviceId_idx" ON "dozo_browser_consents"("deviceId");
