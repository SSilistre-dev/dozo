import { createHash } from "node:crypto";
import type { Prisma } from "./client.js";
import { runAsSystemInTransaction } from "./row-security.js";
import { securityEventMetadata, securityRequestCaller } from "./security-events.js";

type Value = string | number | boolean | null;

/**
 * Records a change an admin made to the deployment as a `deployment.settings.changed` security
 * event, in the change's own transaction: if the record cannot be written, the change is undone
 * with it. `metadata` carries which setting and its values before and after.
 */
export async function recordAdminChange(
  tx: Prisma.TransactionClient,
  byUserId: string,
  metadata: Record<string, Value>,
): Promise<void> {
  const caller = securityRequestCaller();
  // The table is only ever read as system, whoever's request writes it.
  await runAsSystemInTransaction(tx, "record an admin change", () =>
    tx.securityEvent.create({
      data: {
        type: "deployment.settings.changed",
        userId: byUserId,
        ip: caller?.ip?.slice(0, 64) ?? null,
        userAgent: caller?.userAgent?.slice(0, 512) ?? null,
        metadata: securityEventMetadata(metadata),
      },
    }),
  );
}

/**
 * An address as security events may hold it: security events keep no addresses (their metadata
 * redacts them), so a change of address is recorded as this fingerprint, which tells whether a
 * given address was the one before or after without storing it.
 */
export function addressFingerprint(address: string): string {
  return createHash("sha256").update(address.trim().toLowerCase()).digest("hex").slice(0, 16);
}
