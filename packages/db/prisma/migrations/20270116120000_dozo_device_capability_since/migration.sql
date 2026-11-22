-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in
-- packages/adapters/src/dozo-device-capabilities.ts.

-- When each capability a paired device declares was last turned on: set when it appears in a
-- declaration it was missing from, dropped when it goes. A bot's consent to read a kind of the
-- user's phone counts only from then, so turning that switch off and on again asks again. Like
-- dozo_device_capabilities, it is reached only by the device's own connection and the server, so
-- it has no row policy.
CREATE TABLE "dozo_device_capability_since" (
  "deviceId" TEXT NOT NULL REFERENCES "user_devices"("id") ON DELETE CASCADE,
  "capability" TEXT NOT NULL,
  "since" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("deviceId", "capability")
);
