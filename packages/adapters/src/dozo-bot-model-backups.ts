import type { ModelRoleChoice } from "@rakazo/contracts";
import { modelRoleChoiceKey } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { readBotModelBackups } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { backupsPastRests } from "./dozo-model-rests.js";
import type { DeploymentModelDefaults } from "./model-roles.js";
import { effectiveModelRole } from "./model-roles.js";

type Db = Pick<
  PrismaClient,
  | "$queryRaw"
  | "$executeRaw"
  | "spaceModelRoleChoice"
  | "userModelRoleChoice"
  | "spaceSettingOverride"
  | "userModelCredential"
  | "userModelPreference"
>;

/**
 * The backups a run of a bot moves to, in order: the bot's own when it has any, else the runner's
 * as before. A bot's row pinned to a connection that is not the runner's runs on the runner's own
 * connection of that provider, as the bot's own model does, so nobody's run uses another member's
 * connection. A bot list that cannot be read leaves the runner's backups in place. Either list
 * keeps its order, except that a resting model goes last.
 */
export async function runBackupModels(
  prisma: Db,
  run: { userId: string; spaceId: string; botId?: string | null },
  defaults: DeploymentModelDefaults,
): Promise<{ backups: ModelRoleChoice[] }> {
  const own = run.botId
    ? ((await bestEffort("bot backup models read", readBotModelBackups(prisma, run.botId))) ?? [])
    : [];
  const role = own.length
    ? { backups: await onRunnersConnections(prisma, run.userId, own) }
    : await effectiveModelRole(prisma, run, "main", defaults);
  // One resting after its quota ran out is reached only after every other (dozo-model-rests.ts).
  return { ...role, backups: await backupsPastRests(prisma, run.userId, role.backups) };
}

async function onRunnersConnections(
  prisma: Pick<PrismaClient, "userModelCredential">,
  userId: string,
  backups: ModelRoleChoice[],
): Promise<ModelRoleChoice[]> {
  const pinned = backups.flatMap((choice) => (choice.credentialId ? [choice.credentialId] : []));
  const runners = new Set(
    pinned.length
      ? (
          await prisma.userModelCredential.findMany({
            where: { userId, id: { in: pinned } },
            select: { id: true },
          })
        ).map((connection) => connection.id)
      : [],
  );
  const seen = new Set<string>();
  return backups.flatMap((choice) => {
    const { credentialId, ...rest } = choice;
    const resolved = credentialId && !runners.has(credentialId) ? rest : choice;
    const key = modelRoleChoiceKey(resolved);
    if (seen.has(key)) return [];
    seen.add(key);
    return [resolved];
  });
}
