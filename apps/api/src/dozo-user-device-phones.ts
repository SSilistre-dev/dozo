import type { UserDevices } from "@rakazo/adapters";
import { isPhonePlatform, PHONE_PLATFORMS } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { recordSecurityEvent } from "@rakazo/db";

/**
 * An account has one phone, and its phone is not one of its computers (dozo-user-device-gateway.ts),
 * so it takes no place under the computers' limit. Both are read and written in the pairing's own
 * transaction (user-devices.ts), under its lock.
 */
type Devices = Pick<PrismaClient, "userDevice">;

/** The account's phones still paired. */
export async function pairedPhones(db: Devices, userId: string): Promise<string[]> {
  const phones = await db.userDevice.findMany({
    where: { userId, revokedAt: null, platform: { in: [...PHONE_PLATFORMS] } },
    select: { id: true },
  });
  return phones.map((phone) => phone.id);
}

/** Whether this pairing counts against the computers' limit: a phone's never does. */
export function overComputerLimit(
  platform: string,
  active: number,
  phones: readonly string[],
  limit: number,
): boolean {
  return !isPhonePlatform(platform) && active - phones.length >= limit;
}

/**
 * When a phone is pairing, ends the phones paired before it, in the pairing's transaction, so a
 * pairing that fails ends none. Returns the ones it ended, for `disconnectPhones` after commit.
 */
export async function replacePhones(
  db: Devices,
  userId: string,
  platform: string,
  phones: string[],
): Promise<string[]> {
  if (!isPhonePlatform(platform) || !phones.length) return [];
  await db.userDevice.updateMany({
    where: { id: { in: phones }, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedBy: "owner" },
  });
  return phones;
}

/** After the pairing committed: records each phone it ended and closes its socket. */
export async function disconnectPhones(
  devices: UserDevices,
  userId: string,
  phones: readonly string[],
) {
  for (const deviceId of phones) {
    await recordSecurityEvent({
      type: "device.revoked",
      userId,
      metadata: { deviceId, by: "owner" },
    });
    await devices.disconnect(deviceId);
  }
}
