import { modelPicked } from "@rakazo/adapters";
import type { ModelRoleChoice, SettingsScope } from "@rakazo/contracts";
import { backupChoiceKey } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { appliedModelRole } from "@rakazo/db";

/**
 * Picking a model ends its rests (packages/adapters/src/dozo-model-rests.ts), so the person's
 * next run tries it at once. A pick is a save that makes it the person's main model or a bot's
 * model where it was not: a save that keeps the same model (an effort change, a reorder) is not.
 * Rests end only once the save went through.
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

/**
 * For the bots route, after the save: passes the bot as it was before the save through, once a
 * model change in `input` ended its rests.
 */
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

/**
 * For the models route, before it saves: whether the save picks a main model in place of
 * another. Answers what to pass the saved settings through, which ends that model's rests once
 * the save went through, and does nothing for any other save.
 */
export async function mainModelPicked(
  prisma: Db,
  actor: Actor,
  role: string,
  primary: ModelRoleChoice | null | undefined,
  scope?: SettingsScope,
): Promise<<T>(saved: T) => Promise<T>> {
  const keep = async <T>(saved: T) => saved;
  if (role !== "main" || !primary) return keep;
  const current = await appliedModelRole(prisma, actor, "main", scope);
  if (current.primary && backupChoiceKey(current.primary) === backupChoiceKey(primary)) return keep;
  return async (saved) => {
    await modelPicked(prisma, actor.userId, primary);
    return saved;
  };
}
