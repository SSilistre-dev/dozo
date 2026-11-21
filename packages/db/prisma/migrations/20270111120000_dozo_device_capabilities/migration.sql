-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in
-- packages/adapters/src/dozo-device-capabilities.ts.

-- What a paired computer said it can do when it last connected ("shell", "screen"), so every API
-- and worker process offers a run only those tools. A computer that says nothing has no row and
-- gets commands alone. Like user_devices, it is reached only by the device's own connection and
-- the server, so it has no row policy.
CREATE TABLE "dozo_device_capabilities" (
  "deviceId" TEXT NOT NULL PRIMARY KEY REFERENCES "user_devices"("id") ON DELETE CASCADE,
  "capabilities" TEXT[] NOT NULL
);
