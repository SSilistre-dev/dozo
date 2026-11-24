import { randomBytes } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import { VAULT_ITEM_LIMIT } from "@rakazo/contracts";
import { ClientError, retry } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { newVaultItemName } from "./bot-secrets.js";
import { readDeviceCapabilities } from "./dozo-device-capabilities.js";
import { encodeDeviceLogin } from "./dozo-device-login.js";
import { persistPreparedSecret } from "./secret-persistence.js";
import { sealVaultValue } from "./vault-values.js";

/**
 * The vault side of a login linked to a computer's password manager. The item is an ordinary
 * account vault login, so the vault's own rules and approvals apply to it, but what it stores is
 * only the computer and the handle (dozo-device-login.ts): there is no value on the server.
 */
type Deps = { prisma: PrismaClient; secretStore: SecretStore };
type Device = { id: string; userId: string };

const NAME_ATTEMPTS = 5;

/** Whether this computer declared passwords on its last connection; never a phone. */
export async function deviceCanLink(
  prisma: PrismaClient,
  device: { id: string; platform: string },
): Promise<boolean> {
  return (await readDeviceCapabilities(prisma, device.id, device.platform)).includes("passwords");
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

/** The name of the item this computer's handle is linked to, if it is. */
async function linkedName(prisma: PrismaClient, deviceId: string, handle: string) {
  const rows = await runAsSystem(
    "read a linked login's name",
    () =>
      prisma.$queryRaw<{ name: string }[]>`
      SELECT v.name AS name FROM dozo_device_logins l JOIN vault_credentials v ON v.id = l."credentialId"
      WHERE l."deviceId" = ${deviceId} AND l.handle = ${handle}`,
  );
  return rows[0]?.name;
}

/**
 * Saves the login the computer linked and answers its name, one free name from the title. A
 * handle the computer already linked answers its item again, saving nothing. Refused at the
 * vault's limit and for a computer that was disconnected since it asked.
 */
export async function createDeviceLogin(
  { prisma, secretStore }: Deps,
  device: Device,
  input: { title: string; origin: string; handle: string },
): Promise<{ name: string; created: boolean }> {
  const known = await linkedName(prisma, device.id, input.handle);
  if (known) return { name: known, created: false };
  const scope = { userId: device.userId, spaceId: "", vault: "account" as const };
  // Each try picks a free name again; only a collision on the unique name is tried again.
  return retry(
    async () => {
      const id = randomBytes(12).toString("hex");
      const name = await runAsSystem("name a linked login", () =>
        newVaultItemName(prisma, scope, input.title, "login"),
      );
      const ciphertext = await sealVaultValue(
        prisma,
        secretStore,
        { id, userId: device.userId, spaceId: null },
        encodeDeviceLogin({ deviceId: device.id, handle: input.handle }),
        {
          operationId: id,
          traceId: id,
          userId: device.userId,
          spaceId: "",
          signal: new AbortController().signal,
        },
      );
      try {
        await persistPreparedSecret(prisma, secretStore, { id, ciphertext }, () =>
          runAsSystem("save a linked login", () =>
            prisma.$transaction(async (tx) => {
              // The vault's own order for a write: the owner's row, then the count under it.
              await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${device.userId} FOR UPDATE`;
              // A computer disconnected meanwhile has already had its links removed.
              const live = await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM user_devices WHERE id = ${device.id} AND "revokedAt" IS NULL FOR SHARE`;
              if (!live.length)
                throw new ClientError(
                  "UNAUTHORIZED",
                  "This computer is not connected to the account",
                );
              const items = await tx.vaultCredential.count({
                where: { userId: device.userId, spaceId: null },
              });
              if (items >= VAULT_ITEM_LIMIT)
                throw new ClientError("CONFLICT", "Credential limit reached");
              await tx.vaultCredential.create({
                data: {
                  id,
                  userId: device.userId,
                  spaceId: null,
                  name,
                  title: input.title,
                  origin: input.origin,
                  auth: { type: "login" },
                  ciphertext,
                },
              });
              await tx.$executeRaw`
              INSERT INTO dozo_device_logins ("deviceId", handle, "credentialId")
              VALUES (${device.id}, ${input.handle}, ${id})`;
            }),
          ),
        );
        return { name, created: true };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The same handle saved by a request that raced this one, or the name taken meanwhile.
        const raced = await linkedName(prisma, device.id, input.handle);
        if (raced) return { name: raced, created: false };
        throw error;
      }
    },
    { attempts: NAME_ATTEMPTS, delayMs: 0, retryable: isUniqueViolation },
  );
}

/**
 * Removes the login a computer linked under `handle`, and only if that computer linked it: a
 * handle of another computer matches nothing. Every login of a computer that is disconnected goes
 * with it, in the database itself (the trigger of the migration), whichever way it was revoked.
 */
export async function deleteDeviceLogin(
  prisma: PrismaClient,
  deviceId: string,
  handle: string,
): Promise<boolean> {
  const ids = await runAsSystem(
    "find a computer's linked login",
    () =>
      prisma.$queryRaw<{ id: string }[]>`
      SELECT "credentialId" AS id FROM dozo_device_logins
      WHERE "deviceId" = ${deviceId} AND handle = ${handle}`,
  );
  if (!ids.length) return false;
  // Through the model, so a stored value's own cleanup runs as it does for any vault removal.
  const { count } = await runAsSystem("remove a computer's linked login", () =>
    prisma.vaultCredential.deleteMany({ where: { id: { in: ids.map((row) => row.id) } } }),
  );
  return count > 0;
}
