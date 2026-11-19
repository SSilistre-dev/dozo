import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { appliedModelRole } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type Scope = { userId: string; spaceId: string; botId?: string };
type Model = AgentRunRequest["model"];
type ResolveModel = (scope: Scope) => Promise<Model>;

export type CompactionModelSources = {
  /** What runs the thread: today's summarizer. Absent, compaction falls back on its own. */
  resolveModel?: ResolveModel;
  /** A model of the member's on the connection its role row names. */
  resolveConnectedModel: (
    scope: { userId: string; spaceId: string },
    provider: string,
    modelId: string,
    registerSecrets?: (values: string[]) => void,
    requireStoredSecret?: boolean,
    thinkingLevel?: string | null,
    credentialId?: string,
  ) => Promise<Model>;
};

type RoleClient = Parameters<typeof appliedModelRole>[0] &
  Pick<PrismaClient, "spaceSettingOverride">;

/** The first of the member's compaction role choices that resolves, in order; none, undefined. */
async function compactionRoleModel(
  prisma: RoleClient,
  sources: CompactionModelSources,
  { userId, spaceId }: Scope,
) {
  const { primary, backups } = await appliedModelRole(prisma, { userId, spaceId }, "compaction");
  for (const choice of primary ? [primary, ...backups] : []) {
    try {
      return await sources.resolveConnectedModel(
        { userId, spaceId },
        choice.provider,
        choice.modelId,
        undefined,
        false,
        choice.thinkingLevel ?? null,
        choice.credentialId,
      );
    } catch (error) {
      getLogger().warn("history.compact.model_unavailable", { error });
    }
  }
  return undefined;
}

/**
 * Runs one history compaction with the member's compaction role model, so summaries can run on
 * a cheaper model than the conversation. Without a choice, or when none resolves, the thread's
 * model writes it as before. When the role model fails the summary (the provider refuses it, or
 * the transcript does not fit its window), the same compaction runs once more on the thread's
 * model, so a bad choice never leaves the history unsummarized.
 */
export async function compactWithRoleModel(
  prisma: RoleClient,
  sources: CompactionModelSources,
  compact: (resolveModel?: ResolveModel) => Promise<void>,
) {
  const threadModel = sources.resolveModel;
  if (!threadModel) return compact();
  let roleModelUsed = false;
  try {
    await compact(async (scope) => {
      const model = await compactionRoleModel(prisma, sources, scope);
      roleModelUsed = Boolean(model);
      return model ?? threadModel(scope);
    });
  } catch (error) {
    if (!roleModelUsed) throw error;
    getLogger().warn("history.compact.role_model_failed", { error });
    await compact(threadModel);
  }
}
