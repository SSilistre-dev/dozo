import type { AutoReviewProvider, AutoReviewResult } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markReadOutsideContent } from "./run-context.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";

// The branded tool gate when Auto review sends an action to the approval model: a member who
// picked only backup approval models (no primary, and none set for the deployment) has their
// backups judge it, every consequential tool alike, and a judge plan no model answered asks.
// Runs on the staged tree.

const seen = vi.hoisted(() => ({
  plans: [] as string[],
  blocks: [] as unknown[],
  /** The model each review went to. */
  reviews: [] as string[],
  verdict: "pass" as AutoReviewResult["decision"] | "throws",
}));
vi.mock("@rakazo/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return {
    ...core,
    planActionGate: (input: Parameters<typeof core.planActionGate>[0]) => {
      const plan = core.planActionGate(input);
      seen.plans.push(plan);
      return plan;
    },
  };
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
  readDozoCommandRules: vi.fn(async () => []),
  readDozoHostedAsks: vi.fn(async () => false),
  readRoutineWriter: vi.fn(async () => undefined),
  takeDozoDailySend: vi.fn(async () => ({ full: false, dailySends: 100 })),
}));
vi.mock("./run-auto-review.js", () => ({
  // The model a review goes to answers as the test says, and is recorded by name.
  autoReviewCheckerProvider: async (
    _deps: unknown,
    _scope: unknown,
    _options: unknown,
    checker: { model: string },
  ): Promise<AutoReviewProvider> => ({
    describe: () => ({
      id: "scripted",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { offline: true, keyless: true },
    }),
    review: async () => {
      seen.reviews.push(checker.model);
      if (seen.verdict === "throws") throw new Error("checker down");
      return { decision: seen.verdict, reason: "Scripted.", model: checker.model };
    },
  }),
}));
vi.mock("./run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => ({
    duplicate: false,
    effect: { id: "effect-1", status: "intended" },
  })),
  claimEffect: vi.fn(async () => true),
}));
vi.mock("./run-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  renewRunLease: vi.fn(async () => true),
  enqueueSteeringContinuation: vi.fn(async () => {}),
}));
vi.mock("./run-notifications.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyRun: vi.fn(async () => {}),
}));
vi.mock("./run-context.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  persistTurnCheckpoint: vi.fn(async () => {}),
}));

type Mode = "ask" | "auto" | "never";
/** Which approval models the member set: only backups, none at all, or (impossible) a primary with no model. */
type Models = "backups" | "none" | "unrunnable";
const APP_ACTION = "tracker-create-issue";

/** One consequential call of each kind the gate judges. `read` marks outside content first. */
const CALLS: Record<string, { name: string; args: Record<string, unknown>; read?: true }> = {
  "sending an email": {
    name: "send_email",
    args: { to: "someone@example.test", subject: "Hi", body: "Hello" },
  },
  "an app action": { name: APP_ACTION, args: { title: "Bug" } },
  "deleting an email": { name: "delete_email", args: { id: "mail-1" } },
  "making a group": { name: "create_group", args: { name: "Team" } },
  "a memory save after outside content": {
    name: "remember",
    args: { content: "The owner prefers mornings" },
    read: true,
  },
  "a command on the bot's computer": { name: "shell", args: { command: "npm install" } },
};

function context(options: { mode?: Mode; models?: Models; trigger?: string } = {}) {
  const mode = options.mode ?? "auto";
  const models = options.models ?? "backups";
  const trigger = options.trigger ?? "user";
  return {
    deps: {
      autoReview: undefined,
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
      events: {
        pauseRunForInput: async (input: { blocks: unknown[] }) => {
          seen.blocks.push(...input.blocks);
          return { continuationRunId: null };
        },
      },
    },
    run: {
      id: "run-1",
      userId: "owner",
      routineId: trigger === "routine" ? "routine-1" : null,
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
    task: { prompt: "Tidy up my week" },
    secrets: [],
    computer: { checkpoint: { flush: async () => {} } },
    settleRunningHelpers: async () => {},
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun: trigger === "user", messagingChannelRun: false },
    tools: {
      connector: new Map([[APP_ACTION, { readOnly: false }]]),
      connectedPlugins: [],
    },
    state: {
      tainted: trigger !== "user",
      earlierAttempt: undefined,
      approval: {},
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () => [],
      loadAutoReviewPreference: async () => ({
        enabled: mode === "auto",
        skipApprovals: mode === "never",
      }),
      loadApprovalModel: async () => ({
        primary: null,
        primarySource: models === "unrunnable" ? "member" : null,
        backups:
          models === "backups"
            ? [
                { provider: "backup", modelId: "backup-1", thinkingLevel: undefined },
                { provider: "backup", modelId: "backup-2", thinkingLevel: undefined },
              ]
            : [],
      }),
      loadOwnerWords: async () => "Tidy up my week",
      receivedOutsideMessage: async () => false,
      routineNamesNewSite: async () => false,
      loadTrustedSites: async () => new Set<string>(),
      loadTrustedConnectors: async () => new Set<string>(),
    },
  };
}

function request(name: string, args: Record<string, unknown>): ToolRequest {
  const executionId = JSON.stringify(["pi-tool", "main", `call-${Math.random()}`]);
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
    loginUse: undefined,
  };
}

type Outcome = "runs" | "reviewed" | "card" | "refused";

async function outcome(
  call: (typeof CALLS)[string],
  options: Parameters<typeof context>[0] = {},
): Promise<Outcome> {
  const ctx = context(options);
  if (call.read) await markReadOutsideContent(ctx as never);
  const before = { blocks: seen.blocks.length, reviews: seen.reviews.length };
  const result = await gateToolCall(ctx as never, request(call.name, { ...call.args }), undefined);
  if (seen.blocks.length > before.blocks) return "card";
  if ("call" in result) return seen.reviews.length > before.reviews ? "reviewed" : "runs";
  return "refused";
}

beforeEach(() => {
  seen.plans.length = 0;
  seen.blocks.length = 0;
  seen.reviews.length = 0;
  seen.verdict = "pass";
});

describe.each(Object.entries(CALLS))("%s in Auto review", (_label, call) => {
  it("goes to the first backup model when the member picked only backups", async () => {
    expect(await outcome(call)).toBe("reviewed");
    expect(seen.plans).toEqual(["judge"]);
    expect(seen.reviews).toEqual(["backup-1"]);
  });

  it("asks with a card when the backup asks", async () => {
    seen.verdict = "ask";
    expect(await outcome(call)).toBe("card");
    expect(seen.reviews).toEqual(["backup-1"]);
  });

  it.each(["error", "throws"] as const)(
    "asks with a card when every backup answers %s",
    async (verdict) => {
      seen.verdict = verdict;
      expect(await outcome(call)).toBe("card");
      expect(seen.reviews).toEqual(["backup-1", "backup-2"]);
    },
  );

  it("asks with a card when there is no approval model at all", async () => {
    expect(await outcome(call, { models: "none" })).toBe("card");
    expect(seen.reviews).toEqual([]);
  });

  it("asks with a card when the plan is to judge and no model would run", async () => {
    expect(await outcome(call, { models: "unrunnable" })).toBe("card");
    expect(seen.reviews).toEqual([]);
  });

  it("waits on a card in a routine nobody watches, as any card does", async () => {
    seen.verdict = "ask";
    expect(await outcome(call, { trigger: "routine" })).toBe("card");
  });

  it("is unchanged in Ask and Never ask", async () => {
    for (const models of ["backups", "none"] as const) {
      expect(await outcome(call, { mode: "ask", models }), models).toBe("card");
      expect(await outcome(call, { mode: "never", models }), models).toBe("runs");
    }
    expect(seen.reviews).toEqual([]);
  });
});
