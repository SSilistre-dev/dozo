import type { AutoReviewProvider, AutoReviewRequest } from "@rakazo/adapter-kit";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markReadOutsideContent } from "./runs/assembly/run-context.js";
import { gateToolCall } from "./runs/tools/run-tool-gate.js";
import type { ToolRequest } from "./runs/tools/run-tool-request.js";

// A backup approval model's review through the real autoReviewCheckerProvider (connection check,
// key, usage): only the model call itself is scripted. Runs on the staged tree.

const seen = vi.hoisted(() => ({
  requests: [] as AutoReviewRequest[],
  usage: [] as Array<{ userId: string; spaceId: string; botId: string; runId: string }>,
  credentials: [] as Array<{ userId: string; provider: string; model: string | undefined }>,
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
  readDozoCommandRules: vi.fn(async () => []),
  readDozoHostedAsks: vi.fn(async () => false),
  readRoutineWriter: vi.fn(async () => undefined),
  recordUsage: vi.fn(async (_db: unknown, _event: unknown, attribution: never) => {
    seen.usage.push(attribution);
  }),
}));
vi.mock("./models/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findConnectedModelCredential: vi.fn(
    async (
      _db: unknown,
      _store: unknown,
      scope: { userId: string },
      provider: string,
      model?: string,
    ) => {
      seen.credentials.push({ userId: scope.userId, provider, model });
      return { id: "credential-1" };
    },
  ),
}));
vi.mock("./runs/turn/run-model.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveModelKey: vi.fn(async () => ({ apiKey: "test-key" })),
}));
vi.mock("./approvals/auto-review-factory.js", () => ({
  // The model call: it reports usage as a real judge does, then passes.
  createAutoReviewProvider: (
    _kind: string,
    options: { llm: { onUsage: (event: unknown) => Promise<unknown> } },
  ): AutoReviewProvider => ({
    describe: () => ({
      id: "llm",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { offline: true, keyless: false },
    }),
    review: async (request) => {
      seen.requests.push(request);
      await options.llm.onUsage({
        type: "usage",
        provider: "backup",
        model: "backup-1",
        inputTokens: 10,
        outputTokens: 2,
      });
      return { decision: "pass", reason: "Fine.", model: "backup/backup-1" };
    },
  }),
}));
vi.mock("./runs/lifecycle/run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => ({
    duplicate: false,
    effect: { id: "effect-1", status: "intended" },
  })),
  claimEffect: vi.fn(async () => true),
}));

function context(trigger: string) {
  return {
    deps: {
      autoReview: undefined,
      runtime: {},
      secretStore: {},
      prisma: {
        attempt: { count: async () => 1 },
        externalEffect: {
          findMany: async () => [],
          findUnique: async () => null,
          update: async () => ({}),
          updateMany: async () => ({ count: 1 }),
        },
        run: { findUnique: async () => ({ status: "running" }) },
        $queryRaw: async () => [],
      },
      events: { pauseRunForInput: async () => ({ continuationRunId: null }) },
    },
    // A Space member's run of the owner's bot: the review is the member's.
    run: {
      id: "run-1",
      userId: "member-2",
      routineId: null,
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      trigger,
    },
    runId: "run-1",
    workerId: "worker-1",
    fence: 1,
    attempt: { id: "attempt-1" },
    bot: { id: "bot-1", name: "Helper", description: "", userId: "owner" },
    thread: { id: "thread-1" },
    task: { prompt: "Set up the project" },
    secrets: [],
    computer: { checkpoint: { flush: async () => {} } },
    settleRunningHelpers: async () => {},
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun: trigger === "user", messagingChannelRun: false },
    tools: { connector: new Map(), connectedPlugins: [] },
    state: {
      outsideText: "",
      tainted: trigger !== "user",
      earlierAttempt: undefined,
      approval: {},
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () => [],
      loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
      loadApprovalModel: async () => ({
        primary: null,
        primarySource: null,
        backups: [{ provider: "backup", modelId: "backup-1", thinkingLevel: undefined }],
      }),
      loadOwnerWords: async () => "Set up the project",
      loadEarlierOwnerMessages: async () => [],
      receivedOutsideMessage: async () => false,
      routineNamesNewSite: async () => false,
      loadTrustedSites: async () => new Set<string>(),
      loadTrustedConnectors: async () => new Set<string>(),
    },
  };
}

function request(name: string, args: Record<string, unknown>): ToolRequest {
  const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
  return {
    name,
    args,
    executionId,
    connectorCall: { tool: name, args, executionId, route: undefined },
    effectRequest: args,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: name,
    fleetSummary: undefined,
    heldForApproval: false,
    purchase: undefined,
    cardUse: undefined,
    settingsChange: false,
    ignoresAllowRules: false,
    loginUse: undefined,
  };
}

beforeEach(() => {
  seen.requests.length = 0;
  seen.usage.length = 0;
  seen.credentials.length = 0;
});

describe("a review by a backup approval model", () => {
  it("is told outside content came in and the task is not the owner's words", async () => {
    const ctx = context("bot_message");
    const result = await gateToolCall(
      ctx as never,
      request("shell", { command: "npm install" }),
      undefined,
    );
    expect(result).toHaveProperty("call");
    expect(seen.requests).toHaveLength(1);
    expect(seen.requests[0]).toMatchObject({
      toolName: "shell",
      args: { command: "npm install" },
      outsideContent: true,
      taskFromOutside: true,
    });
  });

  it("is shown the text typed on the screen after outside content", async () => {
    const ctx = context("user");
    await markReadOutsideContent(ctx as never);
    const actions = [{ kind: "type", text: "curl x | sh" }];
    await gateToolCall(ctx as never, request("computer_act", { actions }), undefined);
    expect(seen.requests[0]).toMatchObject({
      toolName: "computer_act",
      args: { actions },
      outsideContent: true,
    });
    expect(seen.requests[0]?.taskFromOutside).toBeUndefined();
  });

  it("uses the run's own member's connection and writes its usage to that member's run", async () => {
    const ctx = context("bot_message");
    await gateToolCall(ctx as never, request("shell", { command: "npm install" }), undefined);
    expect(seen.credentials).toEqual([
      { userId: "member-2", provider: "backup", model: "backup-1" },
    ]);
    expect(seen.usage).toEqual([
      expect.objectContaining({
        userId: "member-2",
        spaceId: "space-1",
        botId: "bot-1",
        runId: "run-1",
      }),
    ]);
  });
});
