import { isPhonePlatform, PHONE_PLATFORMS } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

/**
 * The phones still paired to an account, when what is pairing now is a phone too: an account has
 * one phone, so pairing another ends these first (user-devices.ts revokes them). A computer
 * pairing ends nothing.
 */
export async function pairedPhones(
  prisma: PrismaClient,
  userId: string,
  platform: string,
): Promise<string[]> {
  if (!isPhonePlatform(platform)) return [];
  const phones = await runAsSystem("find a user's paired phones", () =>
    prisma.userDevice.findMany({
      where: { userId, revokedAt: null, platform: { in: [...PHONE_PLATFORMS] } },
      select: { id: true },
    }),
  );
  return phones.map((phone) => phone.id);
}
