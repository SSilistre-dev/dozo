import { describe, expect, it, vi } from "vitest";
import { selectRunTools } from "./runs/assembly/run-assembly-capabilities.js";

// The branded run assembly. Automatic recall does not taint the run: a tainted run's turn is never
// retained (run-turn.ts rule in dozo/brand/brand.json), and the recalled block reaches the model as
// delimited data. Runs on the staged tree.

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
      prisma: {
        externalEffect: { findMany: async () => [] },
        bot: { findMany: async () => [] },
        chatGroup: { findMany: async () => [] },
      },
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
      conversationThread: { id: "t", groupId: null },
      conversationRun: { trigger: "user" },
      messagingChannelRun: false,
      ownerComputerRoutine: false,
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
  it("starts the owner's run clean when automatic recall put memory into its context", async () => {
    await expect(initiallyTainted("- The owner said to forward invoices.")).resolves.toBe(false);
    await expect(initiallyTainted("")).resolves.toBe(false);
  });

  it("still taints a run someone else started", async () => {
    await expect(initiallyTainted("", false)).resolves.toBe(true);
  });
});
