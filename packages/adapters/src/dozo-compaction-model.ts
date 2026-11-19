import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { appliedModelRole } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type Scope = { userId: string; spaceId: string; botId?: string };
type Model = AgentRunRequest["model"];

export type CompactionModelSources = {
  /** What runs the thread: today's summarizer. */
  resolveModel: (scope: Scope) => Promise<Model>;
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

/**
 * The model that writes history summaries: the member's choices for the compaction role, in
 * order, so summaries can run on a cheaper model than the conversation; without a choice, or
 * when none of them resolves, the model that runs the thread, as before.
 */
export function compactionModelResolver(
  prisma: Parameters<typeof appliedModelRole>[0] & Pick<PrismaClient, "spaceSettingOverride">,
  sources: CompactionModelSources,
): (scope: Scope) => Promise<Model> {
  return async (scope) => {
    const { userId, spaceId } = scope;
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
    return sources.resolveModel(scope);
  };
}
