import { describe, expect, it } from "vitest";
import { loadRunRecords } from "./run-assembly-records.js";

type Input = Parameters<typeof loadRunRecords>;

// Records every prisma query a run makes; each one answers nothing, so loading stops early.
function recordingPrisma() {
  const calls: Array<{ query: string; args: unknown }> = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => (args: unknown) => {
          calls.push({ query: `${name}.${method}`, args });
          return Promise.reject(new Error("no database"));
        },
      },
    );
  const prisma = new Proxy({}, { get: (_target, name: string) => model(name) });
  return { prisma, calls };
}

describe("records listed in the system prompt", () => {
  it("are read in creation order, so the cached prompt prefix survives a row update", async () => {
    const { prisma, calls } = recordingPrisma();
    const hold = {
      deps: { prisma, memoryProviders: { resolve: async () => null } },
      run: { id: "run-1", botId: "bot-1", spaceId: "space-1", userId: "user-1", trigger: "user" },
      secrets: [],
    } as unknown as Input[1];
    await expect(
      loadRunRecords({ contextStrategy: "current" } as unknown as Input[0], hold, {
        saved: { pinnedComputerModels: null },
      } as unknown as Input[2]),
    ).rejects.toThrow();
    const order = [{ createdAt: "asc" }, { id: "asc" }];
    for (const query of ["connection.findMany", "taughtSkill.findMany"])
      expect(calls.find((call) => call.query === query)?.args).toMatchObject({ orderBy: order });
  });
});
