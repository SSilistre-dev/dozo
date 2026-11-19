import { describe, expect, it, vi } from "vitest";
import type { CompactionModelSources } from "./dozo-compaction-model.js";
import { compactionModelResolver } from "./dozo-compaction-model.js";

const scope = { userId: "u", spaceId: "s", botId: "b" };
const threadModel = { provider: "p-main", id: "big" };

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
  } as unknown as Parameters<typeof compactionModelResolver>[0];
  const sources = {
    resolveModel: vi.fn(async () => threadModel),
    resolveConnectedModel: vi.fn(async (_scope: unknown, provider: string, modelId: string) => {
      if (modelId === "gone") throw new Error("credential removed");
      return { provider, id: modelId };
    }),
  } satisfies CompactionModelSources;
  return { resolve: compactionModelResolver(prisma, sources), sources, findMany };
}

describe("history summary model", () => {
  it("is the thread's model when the member chose none, as before", async () => {
    const { resolve, sources, findMany } = setup([]);
    expect(await resolve(scope)).toBe(threadModel);
    expect(sources.resolveModel).toHaveBeenCalledWith(scope);
    expect(findMany.mock.calls[0]).toEqual([
      expect.objectContaining({ where: expect.objectContaining({ role: "compaction" }) }),
    ]);
  });

  it("is the compaction role's model, on the connection its row names", async () => {
    const { resolve, sources } = setup([{ position: 0, modelId: "small", credentialId: "c1" }]);
    expect(await resolve(scope)).toEqual({ provider: "p-cheap", id: "small" });
    expect(sources.resolveConnectedModel).toHaveBeenCalledWith(
      { userId: "u", spaceId: "s" },
      "p-cheap",
      "small",
      undefined,
      false,
      null,
      "c1",
    );
    expect(sources.resolveModel).not.toHaveBeenCalled();
  });

  it("tries the role's backups, then the thread's model, when a choice cannot run", async () => {
    const backup = setup([
      { position: 0, modelId: "gone" },
      { position: 1, modelId: "small" },
    ]);
    expect(await backup.resolve(scope)).toEqual({ provider: "p-cheap", id: "small" });
    const none = setup([{ position: 0, modelId: "gone" }]);
    expect(await none.resolve(scope)).toBe(threadModel);
  });
});
