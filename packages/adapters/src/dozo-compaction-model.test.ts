import { describe, expect, it, vi } from "vitest";
import type { CompactionModelSources } from "./dozo-compaction-model.js";
import { compactWithRoleModel } from "./dozo-compaction-model.js";

type Model = { provider: string; id: string; contextWindow?: number };

const scope = { userId: "u", spaceId: "s", botId: "b" };
const threadModel: Model = { provider: "p-main", id: "big", contextWindow: 200_000 };

function setup(rows: Array<{ position: number; modelId: string; credentialId?: string }>) {
  const findMany = vi.fn(async () =>
    rows.map((row) => ({
      role: "compaction",
      provider: "p-cheap",
      thinkingLevel: null,
      credentialId: null,
      ...row,
    })),
  );
  const prisma = {
    spaceSettingOverride: { findUnique: async () => null },
    userModelRoleChoice: { findMany },
    spaceModelRoleChoice: { findMany },
  } as unknown as Parameters<typeof compactWithRoleModel>[0];
  const sources = {
    resolveModel: vi.fn(async () => threadModel),
    resolveConnectedModel: vi.fn(async (_scope: unknown, provider: string, modelId: string) => {
      if (modelId === "gone") throw new Error("credential removed");
      return { provider, id: modelId, contextWindow: modelId === "tiny" ? 2_000 : 100_000 };
    }),
  } satisfies CompactionModelSources;
  return { prisma, sources, findMany };
}

/** A compaction that records the model it summarized with, failing as a provider would. */
function compaction(fails: (model: Model) => boolean) {
  const used: string[] = [];
  const compact = vi.fn(async (resolveModel?: (s: typeof scope) => Promise<Model>) => {
    const model = resolveModel ? await resolveModel(scope) : { provider: "deployment", id: "d" };
    used.push(model.id);
    if (fails(model)) throw new Error(`history.compact summarizer failed with ${model.id}`);
  });
  return { compact, used };
}

const never = () => false;

describe("history summary model", () => {
  it("is the thread's model when the member chose none, as before", async () => {
    const { prisma, sources, findMany } = setup([]);
    const { compact, used } = compaction(never);
    await compactWithRoleModel(prisma, sources, compact);
    expect(used).toEqual(["big"]);
    expect(findMany.mock.calls[0]).toEqual([
      expect.objectContaining({ where: expect.objectContaining({ role: "compaction" }) }),
    ]);
  });

  it("is the compaction role's model, on the connection its row names", async () => {
    const { prisma, sources } = setup([{ position: 0, modelId: "small", credentialId: "c1" }]);
    const { compact, used } = compaction(never);
    await compactWithRoleModel(prisma, sources, compact);
    expect(used).toEqual(["small"]);
    expect(sources.resolveConnectedModel).toHaveBeenCalledWith(
      { userId: "u", spaceId: "s" },
      "p-cheap",
      "small",
      undefined,
      false,
      null,
      "c1",
    );
  });

  it("tries the role's backups, then the thread's model, when a choice cannot resolve", async () => {
    const backup = setup([
      { position: 0, modelId: "gone" },
      { position: 1, modelId: "small" },
    ]);
    const first = compaction(never);
    await compactWithRoleModel(backup.prisma, backup.sources, first.compact);
    expect(first.used).toEqual(["small"]);
    const none = setup([{ position: 0, modelId: "gone" }]);
    const second = compaction(never);
    await compactWithRoleModel(none.prisma, none.sources, second.compact);
    expect(second.used).toEqual(["big"]);
  });

  it("summarizes again on the thread's model when the role's model fails the summary", async () => {
    // The provider refuses the cheap model (quota, wrong key) ...
    const refused = setup([{ position: 0, modelId: "small" }]);
    const quota = compaction((model) => model.id === "small");
    await compactWithRoleModel(refused.prisma, refused.sources, quota.compact);
    expect(quota.used).toEqual(["small", "big"]);
    // ... or the transcript does not fit its window, which the runtime refuses before sending.
    const small = setup([{ position: 0, modelId: "tiny" }]);
    const window = compaction((model) => (model.contextWindow ?? 0) < 50_000);
    await compactWithRoleModel(small.prisma, small.sources, window.compact);
    expect(window.used).toEqual(["tiny", "big"]);
  });

  it("lets a failure on the thread's own model propagate, so the job retries as before", async () => {
    const { prisma, sources } = setup([]);
    const { compact, used } = compaction(() => true);
    await expect(compactWithRoleModel(prisma, sources, compact)).rejects.toThrow("big");
    expect(used).toEqual(["big"]);
  });

  it("leaves the deployment fallback to compaction when no thread resolver exists", async () => {
    const { prisma, sources } = setup([{ position: 0, modelId: "small" }]);
    const { compact, used } = compaction(never);
    await compactWithRoleModel(prisma, { ...sources, resolveModel: undefined }, compact);
    expect(used).toEqual(["d"]);
  });
});
