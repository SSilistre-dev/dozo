import { modelPicked } from "@rakazo/adapters";
import type { ModelRoleChoice, SettingsScope } from "@rakazo/contracts";
import { backupChoiceKey } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { appliedModelRole } from "@rakazo/db";

/**
 * Picking a model ends its rests (packages/adapters/src/dozo-model-rests.ts), so the person's
 * next run tries it at once. A pick is a save that makes it the person's main model or a bot's
 * model where it was not: a save that keeps the same model (an effort change, a reorder) is not.
 */

type Db = Pick<
  PrismaClient,
  | "$queryRaw"
  | "$executeRaw"
  | "spaceModelRoleChoice"
  | "userModelRoleChoice"
  | "spaceSettingOverride"
>;
type Actor = { userId: string; spaceId: string };

/** For the bots route: passes the bot through once a model change in `input` ended its rests. */
export async function botModelPicked<
  Bot extends { modelProvider: string | null; modelId: string | null },
>(
  prisma: Db,
  actor: Actor,
  input: { modelProvider?: string | null; modelId?: string | null },
  bot: Bot,
): Promise<Bot> {
  const { modelProvider: provider, modelId } = input;
  if (provider && modelId && (provider !== bot.modelProvider || modelId !== bot.modelId))
    await modelPicked(prisma, actor.userId, { provider, modelId });
  return bot;
}

/** For the models route: a main model saved in place of another ends its rests. */
export async function mainModelPicked(
  prisma: Db,
  actor: Actor,
  role: string,
  primary: ModelRoleChoice | null | undefined,
  scope?: SettingsScope,
): Promise<void> {
  if (role !== "main" || !primary) return;
  const current = await appliedModelRole(prisma, actor, "main", scope);
  if (current.primary && backupChoiceKey(current.primary) === backupChoiceKey(primary)) return;
  await modelPicked(prisma, actor.userId, primary);
}
