import type { ModelRoleChoice } from "@rakazo/contracts";
import { modelRoleChoiceKey } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { readBotModelBackups } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
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
>;

/**
 * The backups a run of a bot moves to, in order: the bot's own when it has any, else the runner's
 * as before. A bot's row pinned to a connection that is not the runner's runs on the runner's own
 * connection of that provider, as the bot's own model does, so nobody's run uses another member's
 * connection. A bot list that cannot be read leaves the runner's backups in place.
 */
export async function runBackupModels(
  prisma: Db,
  run: { userId: string; spaceId: string; botId?: string | null },
  defaults: DeploymentModelDefaults,
): Promise<{ backups: ModelRoleChoice[] }> {
  const own = run.botId ? await readOwn(prisma, run.botId) : [];
  if (!own.length) return effectiveModelRole(prisma, run, "main", defaults);
  return { backups: await onRunnersConnections(prisma, run.userId, own) };
}

let missingTableReported = false;

/**
 * The bot's own list, or none when it cannot be read. Between a deploy and its migration the
 * table is not there yet: that is said once, not on every run.
 */
async function readOwn(prisma: Db, botId: string): Promise<ModelRoleChoice[]> {
  try {
    return await readBotModelBackups(prisma, botId);
  } catch (error) {
    const missingTable = /\b42P01\b|dozo_bot_model_backups" does not exist/.test(
      error instanceof Error ? error.message : String(error),
    );
    if (!missingTable) {
      getLogger().warn("bot backup models read failed", { error });
    } else if (!missingTableReported) {
      missingTableReported = true;
      getLogger().warn("bot backup models table is missing; runs use the runner's backups");
    }
    return [];
  }
}

/**
 * A row pinned to a connection that is not the runner's runs on the runner's own connection of
 * the provider, as the bot's model does. That includes the saver's own connection after they
 * removed it: the bot's list keeps the model (removing a connection drops a member's own rows
 * with it, but a bot's list is shared, and its other members may still run that model).
 */
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
