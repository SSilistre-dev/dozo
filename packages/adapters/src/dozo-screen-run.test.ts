import type { AutoReviewProvider, AutoReviewResult } from "@rakazo/adapter-kit";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markReadOutsideContent } from "./run-context.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";

// Allow for this run on a card for input on the bot's screen, through the branded tool gate
// (dozo-screen-run.ts wired in by dozo/brand/brand.json). Runs on the staged tree.

const seen = vi.hoisted(() => ({
  blocks: [] as Array<{ actions?: Array<{ id: string }> }>,
  reviews: 0,
  /** The run's own messages the grant is read from. */
  messageQueries: [] as unknown[],
  /** The approved effect a replayed call finds, or none. */
  approvedEffect: false,
  /** Whether a connection serves the deployment's primary approval model. */
  connected: false,
}));
vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findConnectedModelCredential: vi.fn(async () => (seen.connected ? { id: "credential-1" } : null)),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
  readDozoCommandRules: vi.fn(async () => []),
  readDozoHostedAsks: vi.fn(async () => false),
  readRoutineWriter: vi.fn(async () => undefined),
}));
vi.mock("./run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () =>
    seen.approvedEffect
      ? { duplicate: true, effect: { id: "effect-0", status: "approved" } }
      : { duplicate: false, effect: { id: "effect-1", status: "intended" } },
  ),
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
type Review = AutoReviewResult["decision"] | "off";
type Run = "own" | "webhook" | "channel" | "message" | "token" | "bot_message" | "routine";

const TYPE = { actions: [{ kind: "type", text: "Ada Lovelace" }] };
const CLICK = { actions: [{ kind: "click", x: 10, y: 10 }] };
const ANSWERED = (answer: string) => [
  {
    blocks: [
      {
        kind: "ask",
        approvalEffectId: "effect-0",
        text: "Review before computer_act",
        status: "answered",
        answer,
        actions: [{ id: "allow", label: "Allow once" }],
      },
    ],
  },
];

function reviewer(review: Review): AutoReviewProvider | undefined {
  if (review === "off") return undefined;
  return {
    describe: () => ({
      id: "scripted",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { offline: true, keyless: true },
    }),
    review: async () => {
      seen.reviews++;
      return { decision: review, reason: "Scripted.", model: "scripted" };
    },
  };
}

function context(
  options: {
    mode?: Mode;
    review?: Review;
    run?: Run;
    /** The run already took in outside content (the screen counts). */
    read?: boolean;
    /** The run's own answered cards. */
    answered?: string;
    rules?: Array<{ effect: string; matchKind: string; matchValue: string }>;
    /** The approval models set, when there is no injected reviewer (`review: "off"`). */
    models?: "primary" | "backups";
  } = {},
) {
  const run = options.run ?? "own";
  const trigger =
    run === "webhook"
      ? "webhook"
      : run === "channel"
        ? "messaging"
        : run === "own" || run === "message" || run === "token"
          ? "user"
          : run;
  const ownerStartedRun = trigger === "user";
  return {
    deps: {
      autoReview: reviewer(options.review ?? "pass"),
      prisma: {
        attempt: { count: async () => 1 },
        externalEffect: {
          findMany: async () => [],
          findUnique: async () => null,
          update: async () => ({}),
          updateMany: async () => ({ count: 1 }),
        },
        run: { findUnique: async () => ({ status: "running" }) },
        message: {
          findMany: async (query: unknown) => {
            seen.messageQueries.push(query);
            return options.answered ? ANSWERED(options.answered) : [];
          },
        },
        $queryRaw: async () => [{ sourced: run === "token" }],
      },
      events: {
        pauseRunForInput: async (input: { blocks: typeof seen.blocks }) => {
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
    task: { prompt: "Fill in the form" },
    secrets: [],
    computer: { checkpoint: { flush: async () => {} } },
    settleRunningHelpers: async () => {},
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun, messagingChannelRun: run === "channel" },
    tools: { connector: new Map(), connectedPlugins: [] },
    state: {
      tainted: !ownerStartedRun || Boolean(options.read),
      earlierAttempt: undefined,
      approval: {},
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () => options.rules ?? [],
      loadAutoReviewPreference: async () => ({
        enabled: (options.mode ?? "ask") === "auto",
        skipApprovals: options.mode === "never",
      }),
      loadApprovalModel: async () => ({
        primary:
          options.models === "primary"
            ? { provider: "main", modelId: "main-1", thinkingLevel: undefined }
            : null,
        primarySource: options.models === "primary" ? "deployment" : null,
        backups:
          options.models === "backups"
            ? [{ provider: "backup", modelId: "backup-1", thinkingLevel: undefined }]
            : [],
      }),
      loadOwnerWords: async () => "Fill in the form",
      receivedOutsideMessage: async () => run === "message",
      routineNamesNewSite: async () => false,
      loadTrustedSites: async () => new Set<string>(),
      loadTrustedConnectors: async () => new Set<string>(),
    },
  };
}

function request(name: string, args: Record<string, unknown>, approved = false): ToolRequest {
  const executionId = JSON.stringify(["pi-tool", "main", `call-${Math.random()}`]);
  return {
    name,
    args,
    executionId,
    connectorCall: { tool: name, args, executionId, route: undefined },
    effectRequest: args,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: approved ? name : undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: name,
    fleetSummary: undefined,
    heldForApproval: false,
    purchase: undefined,
    cardUse: undefined,
    loginUse: undefined,
  };
}

/** What happens to one call, and the answers its card offers. */
async function outcome(
  options: Parameters<typeof context>[0] & {
    name?: string;
    args?: Record<string, unknown>;
    approved?: boolean;
  } = {},
) {
  const ctx = context(options);
  if (options.read) await markReadOutsideContent(ctx as never);
  seen.approvedEffect = Boolean(options.approved);
  const before = { blocks: seen.blocks.length, reviews: seen.reviews };
  const args = structuredClone(options.args ?? TYPE) as Record<string, unknown>;
  const result = await gateToolCall(
    ctx as never,
    request(options.name ?? "computer_act", args, options.approved),
    undefined,
  );
  const reviewed = seen.reviews > before.reviews;
  if (seen.blocks.length > before.blocks)
    return {
      result: "card",
      reviewed,
      answers: seen.blocks.at(-1)?.actions?.map((action) => action.id),
    };
  return { result: "call" in result ? "runs" : "refused", reviewed };
}

// A card for input held like a command never offers Always allow, which would pass the tool for good.
const OFFERED = ["allow", "allow_run", "deny"];
const PLAIN = ["allow", "deny"];

beforeEach(() => {
  seen.blocks.length = 0;
  seen.reviews = 0;
  seen.messageQueries.length = 0;
  seen.connected = false;
});

describe("typing on the bot's screen in Ask, in the member's own run after outside content", () => {
  it("asks with a card that offers Allow for this run", async () => {
    expect(await outcome({ read: true })).toEqual({
      result: "card",
      reviewed: false,
      answers: OFFERED,
    });
  });

  it("once allowed for this run, goes to the approval model with no card", async () => {
    expect(await outcome({ read: true, answered: "allow_run" })).toEqual({
      result: "runs",
      reviewed: true,
    });
    // The grant is read from this run's own cards only.
    expect(seen.messageQueries).toEqual([
      { where: { runId: "run-1", role: "bot" }, select: { id: true, blocks: true } },
    ]);
  });

  it.each<Review>(["ask", "error"])(
    "still asks with a card when the model answers %s, without offering it again",
    async (review) => {
      expect(await outcome({ read: true, answered: "allow_run", review })).toEqual({
        result: "card",
        reviewed: true,
        answers: PLAIN,
      });
    },
  );

  it("still asks with a card when there is no approval model, and offers nothing new", async () => {
    expect(await outcome({ read: true, answered: "allow_run", review: "off" })).toEqual({
      result: "card",
      reviewed: false,
      answers: PLAIN,
    });
    expect(await outcome({ read: true, review: "off" })).toMatchObject({ answers: PLAIN });
  });

  it("asks again in a new run, and after any other answer", async () => {
    expect(await outcome({ read: true })).toMatchObject({ result: "card", answers: OFFERED });
    for (const answer of ["allow", "always", "deny"])
      expect(await outcome({ read: true, answered: answer }), answer).toMatchObject({
        result: "card",
        reviewed: false,
      });
  });

  it("runs the call a person just approved without a second review", async () => {
    expect(await outcome({ read: true, answered: "allow_run", approved: true })).toEqual({
      result: "runs",
      reviewed: false,
    });
  });

  it("leaves a command on the bot's computer asking as before", async () => {
    const shell = { name: "shell", args: { command: "npm install" } };
    expect(await outcome({ ...shell, read: true, answered: "allow_run" })).toEqual({
      result: "card",
      reviewed: false,
      // A command's Always allow saves a rule for those words alone, as before.
      answers: ["allow", "always", "deny"],
    });
  });

  it("leaves clicks free and a clean run free, as before", async () => {
    expect(await outcome({ args: CLICK, read: true })).toEqual({ result: "runs", reviewed: false });
    expect(await outcome({})).toEqual({ result: "runs", reviewed: false });
    expect(seen.messageQueries).toEqual([]);
  });

  it("is unchanged in Never ask and by a block rule", async () => {
    expect(await outcome({ mode: "never", read: true })).toEqual({
      result: "runs",
      reviewed: false,
    });
    const block = [{ effect: "deny", matchKind: "tool", matchValue: "computer_act" }];
    expect(await outcome({ read: true, answered: "allow_run", rules: block })).toEqual({
      result: "refused",
      reviewed: false,
    });
  });

  it("is unchanged in Auto review: its cards offer nothing new", async () => {
    expect(await outcome({ mode: "auto", read: true })).toEqual({ result: "runs", reviewed: true });
    expect(await outcome({ mode: "auto", read: true, review: "ask" })).toMatchObject({
      answers: PLAIN,
    });
  });
});

describe.each<Run>(["webhook", "channel", "message", "token", "bot_message", "routine"])(
  "typing on the bot's screen in Ask, in a %s run",
  (run) => {
    it("asks with a plain card, and an earlier Allow for this run counts for nothing", async () => {
      for (const answered of [undefined, "allow_run"]) {
        const result = await outcome({ run, answered, read: true });
        expect(result.result, String(answered)).toBe("card");
        expect(result.reviewed).toBe(false);
        expect(result.answers).not.toContain("allow_run");
      }
    });
  },
);

describe("Allow for this run is offered only when a model would judge the rest", () => {
  it("is not offered for a primary model no connection serves, as the gate counts no model", async () => {
    expect(await outcome({ read: true, review: "off", models: "primary" })).toMatchObject({
      result: "card",
      answers: PLAIN,
    });
  });

  it("is offered once a connection serves it, or for backups only", async () => {
    seen.connected = true;
    expect(await outcome({ read: true, review: "off", models: "primary" })).toMatchObject({
      answers: OFFERED,
    });
    seen.connected = false;
    expect(await outcome({ read: true, review: "off", models: "backups" })).toMatchObject({
      answers: OFFERED,
    });
  });
});

describe("after Allow for this run", () => {
  it("sends each later call to the model, the same keys twice too", async () => {
    const ctx = context({ read: true, answered: "allow_run" });
    await markReadOutsideContent(ctx as never);
    seen.approvedEffect = false;
    const enter = () => ({ actions: [{ kind: "key", key: "Return" }] });
    for (const _ of [1, 2]) {
      const result = await gateToolCall(ctx as never, request("computer_act", enter()), undefined);
      expect(result).toHaveProperty("call");
    }
    expect(seen.reviews).toBe(2);
    expect(seen.blocks).toEqual([]);
  });
});

describe("writing a file on the bot's computer in Ask, after outside content", () => {
  const WRITE = { name: "write_file", args: { path: ".profile", content: "echo hi\n" } };

  it("asks with a card that offers Allow for this run, and then goes to the model", async () => {
    expect(await outcome({ ...WRITE, read: true })).toEqual({
      result: "card",
      reviewed: false,
      answers: OFFERED,
    });
    expect(await outcome({ ...WRITE, read: true, answered: "allow_run" })).toEqual({
      result: "runs",
      reviewed: true,
    });
    expect(await outcome({ ...WRITE, read: true, answered: "allow_run", review: "ask" })).toEqual({
      result: "card",
      reviewed: true,
      answers: PLAIN,
    });
  });

  it.each<Run>(["webhook", "message", "token", "bot_message", "routine"])(
    "offers nothing new in a %s run",
    async (run) => {
      const result = await outcome({ ...WRITE, run, answered: "allow_run", read: true });
      expect(result.result).toBe("card");
      expect(result.answers).not.toContain("allow_run");
    },
  );
});
