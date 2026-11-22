import type { PaymentWalletProvider, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  loadCommandVariables,
  loadLoginPasswordRedactions,
  loadRunCodeRedactions,
  loadRunLoginRedactions,
} from "./bot-secrets.js";
import { loadPurchaseRedactions } from "./purchase-service.js";

export type RunRedactionDeps = {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  paymentWallet?: PaymentWalletProvider | null;
};

/**
 * What a run of the bot hides from its model and from what it stores: the command variables
 * (their environment and encoded forms), then every saved login, card and key, the cards of
 * recent purchases, and the logins and one-time codes given to the runs named. A run loads it for
 * itself at assembly (run-assembly-records.ts); a learning review loads the same for the runs it
 * reads, so both hide exactly the same values.
 */
export async function loadRunRedactions(
  deps: RunRedactionDeps,
  scope: { userId: string; spaceId: string; botId: string },
  runIds: readonly string[],
) {
  const [commands, logins, purchases, runLogins, runCodes] = await Promise.all([
    loadCommandVariables(deps.prisma, deps.secretStore, scope),
    loadLoginPasswordRedactions(deps.prisma, deps.secretStore, scope),
    deps.paymentWallet ? loadPurchaseRedactions(deps, scope) : [],
    Promise.all(
      runIds.map((runId) => loadRunLoginRedactions(deps.prisma, deps.secretStore, scope, runId)),
    ),
    Promise.all(
      runIds.map((runId) => loadRunCodeRedactions(deps.prisma, deps.secretStore, scope, runId)),
    ),
  ]);
  return {
    commands,
    /** Saved logins, purchases' cards, then the runs' logins and codes, as a run adds them. */
    saved: [...logins, ...purchases, ...runLogins.flat(), ...runCodes.flat()],
  };
}
