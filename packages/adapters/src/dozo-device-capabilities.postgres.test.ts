import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDeviceCapabilities, recordDeviceCapabilities } from "./dozo-device-capabilities.js";
import {
  createUserDeviceToken,
  hashUserDeviceToken,
  UserDevices,
  userDeviceForwardSecret,
} from "./dozo-user-device-gateway.js";

// Runs against a migrated database only (dozo/docker/postgres-tests.sh). The fork's unit gate has no
// database and skips it.
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("a paired computer's capabilities (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const userId = `device-capabilities-${randomUUID()}`;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
    await system.user.create({
      data: { id: userId, name: "Ada", email: `${userId}@example.test` },
    });
  });

  afterAll(async () => {
    await system?.user.deleteMany({ where: { id: userId } });
    await db?.pool.end();
  });

  async function pairedDevice() {
    return system.userDevice.create({
      data: {
        userId,
        name: "Laptop",
        platform: "darwin",
        tokenHash: hashUserDeviceToken(createUserDeviceToken()),
      },
    });
  }

  it("keeps the last declaration, forgets it when none is sent, and goes with the device", async () => {
    const device = await pairedDevice();
    expect(await readDeviceCapabilities(db.prisma, device.id)).toEqual(["shell"]);
    await recordDeviceCapabilities(db.prisma, device.id, ["shell", "screen"]);
    expect(await readDeviceCapabilities(db.prisma, device.id)).toEqual(["shell", "screen"]);
    await recordDeviceCapabilities(db.prisma, device.id, ["screen"]);
    expect(await readDeviceCapabilities(db.prisma, device.id)).toEqual(["screen"]);
    await recordDeviceCapabilities(db.prisma, device.id, null);
    expect(await readDeviceCapabilities(db.prisma, device.id)).toEqual(["shell"]);

    await recordDeviceCapabilities(db.prisma, device.id, []);
    expect(await readDeviceCapabilities(db.prisma, device.id)).toEqual([]);
    await system.userDevice.delete({ where: { id: device.id } });
    const left = await system.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM dozo_device_capabilities WHERE "deviceId" = ${device.id}`;
    expect(left[0]?.count).toBe(0);
  });

  it("gives the connected computer what it declared", async () => {
    const device = await pairedDevice();
    await system.userDeviceConnection.create({
      data: { deviceId: device.id, connectionId: randomUUID(), address: "http://api-1" },
    });
    await recordDeviceCapabilities(db.prisma, device.id, ["shell"]);
    const devices = new UserDevices({
      prisma: db.prisma,
      forwardSecret: userDeviceForwardSecret("test"),
    });
    await expect(devices.connected(userId)).resolves.toMatchObject({
      deviceId: device.id,
      platform: "darwin",
      capabilities: ["shell"],
    });
  });
});
