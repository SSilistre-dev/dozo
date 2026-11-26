import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceLoginOf, unlinkDeviceLogin } from "./dozo-device-login.js";
import { createDeviceLogin, deleteDeviceLogin } from "./dozo-device-login-store.js";
import { createUserDeviceToken, hashUserDeviceToken } from "./dozo-user-device-gateway.js";
import { EncryptedSecretStore } from "./secrets/secrets.js";

// Runs against a migrated database only (dozo/docker/postgres-tests.sh). The fork's unit gate has no
// database and skips it.
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const SITE = "https://bank.example.test";
const handle = () => randomUUID().replaceAll("-", "").slice(0, 22);

describePostgres("logins linked to a computer's password manager (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const userId = `device-logins-${randomUUID()}`;
  const otherUserId = `device-logins-${randomUUID()}`;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
    for (const id of [userId, otherUserId])
      await system.user.create({ data: { id, name: "Ada", email: `${id}@example.test` } });
  });

  afterAll(async () => {
    await system?.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await db?.pool.end();
  });

  async function pairedDevice(owner = userId) {
    const device = await system.userDevice.create({
      data: {
        userId: owner,
        name: "Laptop",
        platform: "darwin",
        tokenHash: hashUserDeviceToken(createUserDeviceToken()),
      },
    });
    return { id: device.id, userId: owner };
  }
  const link = (device: { id: string; userId: string }, title: string, key = handle()) =>
    createDeviceLogin({ prisma: db.prisma, secretStore }, device, {
      title,
      origin: SITE,
      handle: key,
    });
  const items = (owner = userId) =>
    system.vaultCredential.findMany({ where: { userId: owner }, orderBy: { name: "asc" } });
  const links = (deviceId: string) =>
    system.$queryRaw<{ handle: string }[]>`
      SELECT handle FROM dozo_device_logins WHERE "deviceId" = ${deviceId}`;

  it("saves an account vault login that holds only the device and the handle", async () => {
    const device = await pairedDevice();
    const key = handle();
    const made = await link(device, "Savings Bank", key);
    expect(made).toEqual({ name: "savings-bank", created: true });
    const row = await system.vaultCredential.findFirstOrThrow({
      where: { userId, name: "savings-bank" },
    });
    expect(row).toMatchObject({
      spaceId: null,
      title: "Savings Bank",
      origin: SITE,
      auth: { type: "login" },
      policy: "allow",
    });
    expect(deviceLoginOf(await secretStore.load(row.ciphertext, row.id))).toEqual({
      deviceId: device.id,
      handle: key,
    });
    expect(await link(device, "Anything", key)).toEqual({ name: "savings-bank", created: false });
    expect((await links(device.id)).map((entry) => entry.handle)).toEqual([key]);
  });

  it("gives two saves at once two names", async () => {
    const device = await pairedDevice();
    const made = await Promise.all([link(device, "Twin Mail"), link(device, "Twin Mail")]);
    expect(made.map((entry) => entry.name).sort()).toEqual(["twin-mail", "twin-mail-2"]);
  });

  it("removes one login by its handle, and only the computer's own", async () => {
    const mine = await pairedDevice();
    const other = await pairedDevice(otherUserId);
    const key = handle();
    await link(mine, "Gone One", key);
    const theirs = handle();
    await createDeviceLogin({ prisma: db.prisma, secretStore }, other, {
      title: "Gone One",
      origin: SITE,
      handle: theirs,
    });
    expect(await deleteDeviceLogin(db.prisma, other.id, key)).toBe(false);
    expect(await deleteDeviceLogin(db.prisma, mine.id, key)).toBe(true);
    expect(await deleteDeviceLogin(db.prisma, mine.id, key)).toBe(false);
    expect((await items()).map((row) => row.name)).not.toContain("gone-one");
    expect((await items(otherUserId)).map((row) => row.name)).toEqual(["gone-one"]);
    expect(await links(mine.id)).toEqual([]);
  });

  it("goes with the computer: revoking it removes every login it linked and no other", async () => {
    const mine = await pairedDevice();
    const spare = await pairedDevice();
    await link(mine, "Revoked A");
    await link(mine, "Revoked B");
    await link(spare, "Kept");
    await system.userDevice.updateMany({
      where: { id: mine.id },
      data: { revokedAt: new Date(), revokedBy: "device" },
    });
    expect((await items()).map((row) => row.name)).not.toContain("revoked-a");
    expect((await items()).map((row) => row.name)).not.toContain("revoked-b");
    expect((await items()).map((row) => row.name)).toContain("kept");
    expect(await links(mine.id)).toEqual([]);
    expect(await links(spare.id)).toHaveLength(1);
    // Revoked again, or edited since: nothing more happens, and nothing breaks.
    await system.userDevice.updateMany({
      where: { id: mine.id },
      data: { revokedAt: new Date(), revokedBy: "owner" },
    });
  });

  it("refuses a computer that is already revoked, and saves nothing", async () => {
    const device = await pairedDevice();
    await system.userDevice.updateMany({
      where: { id: device.id },
      data: { revokedAt: new Date(), revokedBy: "owner" },
    });
    await expect(link(device, "Too Late")).rejects.toMatchObject({ kind: "UNAUTHORIZED" });
    expect((await items()).map((row) => row.name)).not.toContain("too-late");
  });

  it("loses its link row with its item, and the item with the account", async () => {
    const device = await pairedDevice();
    await link(device, "Short Lived");
    await system.vaultCredential.deleteMany({ where: { userId, name: "short-lived" } });
    expect(await links(device.id)).toEqual([]);
  });

  it("keeps an item the owner saved a real value over: revoking and removing leave it", async () => {
    const mine = await pairedDevice();
    const key = handle();
    await link(mine, "Overwritten");
    await link(mine, "Untouched", key);
    const row = await system.vaultCredential.findFirstOrThrow({
      where: { userId, name: "overwritten" },
    });
    await system.$transaction((tx) =>
      unlinkDeviceLogin(tx, row.id, () => secretStore.load(row.ciphertext, row.id)),
    );
    // Not a link any more, whatever the owner saved over it.
    await system.vaultCredential.update({ where: { id: row.id }, data: { ciphertext: "typed" } });
    const other = (await links(mine.id)).map((entry) => entry.handle);
    expect(other).toEqual([key]);
    expect(await deleteDeviceLogin(db.prisma, mine.id, key)).toBe(true);
    await link(mine, "Untouched Again");
    await system.userDevice.updateMany({
      where: { id: mine.id },
      data: { revokedAt: new Date(), revokedBy: "device" },
    });
    const names = (await items()).map((entry) => entry.name);
    expect(names).toContain("overwritten");
    expect(names).not.toContain("untouched-again");
  });
});
