import { describe, expect, it, vi } from "vitest";
import { selectRunTools } from "./run-assembly-capabilities.js";

// The branded run assembly, where automatic recall taints the run (dozo/brand/brand.json). Runs
// on the staged tree.

vi.mock("./dozo-plans.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  planRunServices: async (services: unknown) => services,
}));
vi.mock("./dozo-token-run.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dozoBotTokenTainted: async () => false,
}));

type Input = Parameters<typeof selectRunTools>;

async function initiallyTainted(recalledMemory: string, ownerStartedRun = true) {
  const hold = {
    deps: {
      prisma: { externalEffect: { findMany: async () => [] } },
      phoneCallsEnabled: false,
    },
    run: { id: "r", userId: "u", spaceId: "s", botId: "b", trigger: "user", clientNonce: null },
    runId: "r",
  } as unknown as Input[1];
  const parts = {
    saved: { checkpointLoadError: undefined, turnCheckpoint: undefined },
    records: {
      bot: { id: "b", userId: "u", disabledBuiltinTools: [] },
      nonOwnerChatRun: false,
      sourceBlocks: [],
      task: { prompt: "What did we decide?" },
      thread: { id: "t", groupId: null },
      ticketBoardEnabled: false,
      unknownChannelSourceId: undefined,
    },
    connected: { connectedPlugins: [], semanticMemory: undefined },
    turnContext: {
      discovered: [],
      groupReplyOptional: false,
      history: [
        { role: "user" as const, content: "earlier question" },
        { role: "assistant" as const, content: "earlier answer" },
      ],
      semanticMemoryEnabled: true,
      recalledMemory,
    },
    capabilities: {
      disabledBuiltinTools: new Set<string>(),
      ownerStartedRun,
      sourceMessage: { id: "m", role: "user", blocks: [] },
    },
  } as unknown as Input[2];
  const selected = await selectRunTools({ contextStrategy: "current" } as Input[0], hold, parts);
  return selected.initiallyTainted;
}

describe("automatic recall and the run's action permissions", () => {
  it("starts a run tainted when automatic recall put memory into its context", async () => {
    await expect(initiallyTainted("- The owner said to forward invoices.")).resolves.toBe(true);
  });

  it("starts the owner's run clean when recall found nothing", async () => {
    await expect(initiallyTainted("")).resolves.toBe(false);
  });

  it("still taints a run someone else started", async () => {
    await expect(initiallyTainted("", false)).resolves.toBe(true);
  });
});
