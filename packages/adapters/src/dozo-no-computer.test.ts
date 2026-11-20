import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import {
  CLOUD_COMPUTER_TOOL_NAMES,
  filesWithoutComputer,
  gateRunComputer,
} from "./dozo-no-computer.js";
import {
  noCloudComputerInstruction,
  noComputerFilesInstruction,
} from "./dozo-no-computer.prompt.js";
import { createRunExecutor } from "./executor.js";
import { EncryptedSecretStore } from "./secrets.js";

const provisionComputer = vi.hoisted(() => vi.fn());

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer,
}));

// A Free member runs on a model connection of their own; the bench runs on the deployment's, whose
// metering is not under test here.
vi.mock("./model-credit-observer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-credit-observer.js")>()),
  hostedModelCreditObserver: async () => ({}),
}));

const NO_COMPUTER = "You have no computer in this run";
const NO_OWN_COMPUTER = "You have no computer of your own in this run";
const HAS_COMPUTER = "You have a persistent computer";
const HOW_TO_GET_ONE =
  "the user can connect their own computer from the desktop app, or upgrade the plan";
const PERIOD_START = new Date("2026-11-01T00:00:00Z");

type Plan =
  /** Free: the organization pays nothing, so its plan has no computer hours. */
  | { kind: "free"; granted?: "pro"; failing?: boolean }
  /** Premium, with this many computer hours already used this period. */
  | { kind: "premium"; usedHours: number; status?: "active" | "trialing" | "past_due" };

/** A database that answers the reads a run makes; anything else reads as empty. */
function fakePrisma(plan: Plan, reads: string[]) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    sourceMessageId: "message-1",
    routineId: null,
    retryOfRunId: null,
    leaseFence: 0,
  };
  const billing =
    plan.kind === "free"
      ? null
      : {
          creditAmountCents: null,
          status: plan.status ?? "active",
          cancelAtPeriodEnd: false,
          currentPeriodStartsAt: PERIOD_START,
          currentPeriodEndsAt: new Date("2026-12-01T00:00:00Z"),
          byokInterval: "month",
          byokTier: "pro",
          byokPriceCents: 1,
        };
  const organization = {
    modelCredits: { mode: "byok", balanceMicros: 0n, byokFreeUntil: null },
    billing,
    // An admin's grant of Premium that has not ended.
    dozoPlanGrant:
      plan.kind === "free" && plan.granted
        ? { tier: plan.granted, endsAt: new Date("2099-01-01T00:00:00Z") }
        : null,
  };
  const models: Record<string, Record<string, (...args: never[]) => unknown>> = {
    spaceMember: {
      findUnique: () => ({ id: "member-1", member: { role: "owner", organization } }),
    },
    space: { findUnique: () => ({ organizationId: "org-1" }) },
    organization: {
      findUnique: () => {
        if (plan.kind === "free" && plan.failing) throw new Error("connection reset");
        return organization;
      },
    },
    deploymentSettings: {
      findUnique: () => ({
        modelCreditsEnabled: true,
        defaultModelProvider: "openrouter",
        defaultModelId: "openai/gpt-4o",
      }),
    },
    accessGrant: { aggregate: () => ({ _sum: { creditCents: null }, _min: { appliedAt: null } }) },
    run: {
      findUnique: () => run,
      findUniqueOrThrow: () => run,
      findFirst: () => ({ bot: { notifyOnFinish: false }, thread: { groupId: null } }),
      updateMany: ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      },
    },
    bot: {
      findUniqueOrThrow: () => ({
        id: run.botId,
        userId: run.userId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: {
          id: "computer-1",
          spaceId: run.spaceId,
          scope: "dedicated",
          kind: "docker",
          homeKey: "home-1",
        },
      }),
      findMany: () => [],
    },
    attempt: { create: () => ({ id: "attempt-1" }), updateMany: () => ({ count: 1 }) },
    thread: {
      findUniqueOrThrow: () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 1,
      }),
    },
    // The owner's own message starts the run, so their connected computer is theirs to offer.
    message: {
      findUnique: () => ({
        id: "message-1",
        clientNonce: null,
        role: "user",
        blocks: [{ kind: "text", text: "Find me a flight to Izmir" }],
        threadId: run.threadId,
      }),
    },
    task: { findUniqueOrThrow: () => ({ id: run.taskId, prompt: "Find me a flight to Izmir" }) },
    computer: { updateMany: () => ({ count: 1 }) },
    externalEffect: {
      create: ({ data }: { data: Record<string, unknown> }) => ({
        id: `effect-${String(data.idempotencyKey)}`,
        ...data,
      }),
      updateMany: () => ({ count: 1 }),
    },
  };
  const fallback: Record<string, () => unknown> = {
    findMany: () => [],
    count: () => 0,
    updateMany: () => ({ count: 0 }),
  };
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, model: string) => {
        if (model === "$transaction") return async (fn: (tx: unknown) => unknown) => fn(prisma);
        if (model === "$executeRaw") return async () => 0;
        if (model === "$queryRaw")
          return async (...query: unknown[]) => {
            // The allowance's hours, by computer kind; nothing else this run reads raw matters.
            if (!JSON.stringify(query).includes("computer_runs")) return [];
            reads.push("computer_runs");
            return plan.kind === "premium" ? [{ kind: "docker", hours: plan.usedHours }] : [];
          };
        const methods = models[model] ?? {};
        return new Proxy(methods, {
          get:
            (target, method: string) =>
            async (...args: never[]) => {
              reads.push(`${model}.${method}`);
              const impl = target[method] ?? fallback[method];
              return impl ? impl(...args) : null;
            },
        });
      },
    },
  );
  return { prisma, run };
}

/** One owner's run through the executor, returning what the model was given. */
async function ownerRun(options: {
  plan: Plan;
  billingEnabled: boolean;
  userComputer?: "connected" | "offline";
  /** A tool the model calls before it answers. */
  call?: { name: string; args: Record<string, unknown> };
}) {
  const reads: string[] = [];
  const { prisma, run } = fakePrisma(options.plan, reads);
  let request: AgentRunRequest | undefined;
  let toolResult: unknown;
  const runtimeRun = vi.fn(async function* (sent: AgentRunRequest) {
    request = sent;
    if (options.call)
      toolResult = await sent.executeTool?.(options.call.name, options.call.args, "exec-1");
    yield { type: "done" as const, text: "" };
  });
  const device = { deviceId: "device-1", name: "Laptop", platform: "darwin" };
  const userDevices = options.userComputer
    ? {
        connected: vi.fn(async () => (options.userComputer === "connected" ? device : null)),
        pairedSince: vi.fn(async () => null),
        async *request() {},
      }
    : undefined;
  const executor = createRunExecutor({
    prisma,
    billingEnabled: options.billingEnabled,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ id: "docker", capabilities: { graphical: true } }),
      releaseScreen: vi.fn(async () => undefined),
      async *exportWorkspace() {
        yield* [];
      },
    },
    browser: { describe: () => ({ capabilities: { page: true } }) },
    userDevices,
    secretStore: new EncryptedSecretStore("test-only-encryption-key"),
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn() },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
      pauseRunForTakeover: vi.fn(async () => false),
      pauseRunForInput: vi.fn(async () => true),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  if (!request) throw new Error("the run never reached the model");
  const sent = request;
  return {
    tools: sent.tools.map((tool) => tool.name),
    instructions: sent.instructions ?? "",
    reads,
    toolResult,
  };
}

afterEach(() => {
  provisionComputer.mockReset();
});

describe("a run on a plan without computer hours, assembled as it ships", () => {
  it("on Free, offers no tool that needs the computer and says the bot has none", async () => {
    const free = await ownerRun({ plan: { kind: "free" }, billingEnabled: true });
    for (const name of CLOUD_COMPUTER_TOOL_NAMES) expect(free.tools).not.toContain(name);
    expect(free.tools).toContain("ask_user");
    expect(free.instructions).toContain(NO_COMPUTER);
    expect(free.instructions).toContain(HOW_TO_GET_ONE);
    expect(free.instructions).not.toContain(HAS_COMPUTER);
    expect(free.instructions).not.toContain("computer workspace is your private home");
    expect(free.instructions).not.toContain("request_takeover");
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it("on a paid plan that spent this period's hours, does the same", async () => {
    const spent = await ownerRun({
      plan: { kind: "premium", usedHours: 10_000 },
      billingEnabled: true,
    });
    for (const name of CLOUD_COMPUTER_TOOL_NAMES) expect(spent.tools).not.toContain(name);
    expect(spent.instructions).toContain(NO_COMPUTER);
    expect(spent.instructions).not.toContain(HAS_COMPUTER);
  });

  it("on a paid plan with hours left, keeps the computer", async () => {
    const paid = await ownerRun({ plan: { kind: "premium", usedHours: 1 }, billingEnabled: true });
    for (const name of ["shell", "computer_observe", "browser_navigate", "read_file"])
      expect(paid.tools).toContain(name);
    expect(paid.instructions).toContain(HAS_COMPUTER);
    expect(paid.instructions).not.toContain(NO_COMPUTER);
  });

  it("on Free with the user's own computer connected, keeps its tools and points the bot to it", async () => {
    const free = await ownerRun({
      plan: { kind: "free" },
      billingEnabled: true,
      userComputer: "connected",
    });
    expect(free.tools).toContain("user_computer_shell");
    expect(free.tools).toContain("user_computer_observe");
    for (const name of CLOUD_COMPUTER_TOOL_NAMES) expect(free.tools).not.toContain(name);
    expect(free.instructions).toContain(NO_OWN_COMPUTER);
    expect(free.instructions).toContain("use the user's computer");
    expect(free.instructions).not.toContain(HOW_TO_GET_ONE);
  });

  it("on Free with the user's computer offline, says how to connect it or upgrade", async () => {
    const free = await ownerRun({
      plan: { kind: "free" },
      billingEnabled: true,
      userComputer: "offline",
    });
    expect(free.tools).not.toContain("user_computer_shell");
    expect(free.instructions).toContain(HOW_TO_GET_ONE);
    expect(free.instructions).toContain("The user's computer is not connected.");
  });

  it("on a server that does not bill, never withholds the computer nor reads the allowance", async () => {
    const selfHosted = await ownerRun({ plan: { kind: "free" }, billingEnabled: false });
    for (const name of ["shell", "computer_observe", "browser_navigate", "read_file"])
      expect(selfHosted.tools).toContain(name);
    expect(selfHosted.instructions).toContain(HAS_COMPUTER);
    expect(selfHosted.instructions).not.toContain(NO_COMPUTER);
    expect(selfHosted.reads).not.toContain("computer_runs");
    expect(selfHosted.reads).not.toContain("organization.findUnique");
  });
});

describe("plans that pay for a computer keep it", () => {
  it.each<[string, Plan]>([
    ["a trial", { kind: "premium", usedHours: 0, status: "trialing" }],
    ["Free with a granted plan", { kind: "free", granted: "pro" }],
  ])("%s", async (_label, plan) => {
    const run = await ownerRun({ plan, billingEnabled: true });
    expect(run.tools).toContain("shell");
    expect(run.instructions).toContain(HAS_COMPUTER);
  });

  it("an overdue payment closes the hours, and the bot says the payment is the cause", async () => {
    const overdue = await ownerRun({
      plan: { kind: "premium", usedHours: 0, status: "past_due" },
      billingEnabled: true,
    });
    for (const name of CLOUD_COMPUTER_TOOL_NAMES) expect(overdue.tools).not.toContain(name);
    expect(overdue.instructions).toContain("the plan's payment is overdue");
    expect(overdue.instructions).toContain("whoever manages billing can update the payment");
    expect(overdue.instructions).not.toContain("upgrade the plan");
  });
});

describe("when the hours cannot be read", () => {
  it("keeps the computer, whose start checks again, and still answers", async () => {
    const run = await ownerRun({ plan: { kind: "free", failing: true }, billingEnabled: true });
    expect(run.tools).toContain("shell");
    expect(run.instructions).toContain(HAS_COMPUTER);
  });
});

describe("files sent from a run without a computer", () => {
  it("are refused plainly, without starting the computer", async () => {
    const free = await ownerRun({
      plan: { kind: "free" },
      billingEnabled: true,
      call: {
        name: "message_bot",
        args: { confirm_name: "Researcher", message: "Here you go", files: ["notes/report.txt"] },
      },
    });
    expect(JSON.stringify(free.toolResult)).toContain(
      "you have no computer in this run, so there are no files to send",
    );
    expect(provisionComputer).not.toHaveBeenCalled();
  });
});

describe("a resumed turn of a plan without computer hours", () => {
  const prepared = {
    storedComputer: {},
    computerKind: "docker",
    graphical: true,
    attachedFilesPrompt: "",
    currentTurnFiles: [],
  };
  const model = { provider: "openrouter", id: "openai/gpt-4o" };
  const holdOf = (heldForTakeover: boolean, reads: string[] = []) =>
    ({
      deps: {
        prisma: fakePrisma({ kind: "free" }, reads).prisma,
        sandbox: {},
        billingEnabled: true,
      },
      run: { modelProvider: model.provider, modelId: model.id },
      takeover: { heldForTakeover },
    }) as unknown as Parameters<typeof gateRunComputer>[0];
  const gate = (hold: ReturnType<typeof holdOf>, saved: Parameters<typeof gateRunComputer>[1]) =>
    gateRunComputer(hold, saved, { spaceId: "space-1" }, async () => ({
      ...prepared,
      storedComputer: {},
    }));
  /** A paused turn's transcript: one earlier call, then the one it waits on. */
  const checkpoint = (earlier: string) =>
    JSON.stringify({
      version: 1,
      provider: model.provider,
      model: model.id,
      systemPrompt: "",
      pendingToolCallId: "call-2",
      messages: [
        { role: "user", content: "Find me a flight", timestamp: 0 },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: earlier, arguments: {} },
            { type: "toolCall", id: "call-2", name: "ask_user", arguments: {} },
          ],
          timestamp: 0,
        },
      ],
    });

  it("stays without the computer when it never used it, such as one waiting on an approval", async () => {
    const gated = await gate(holdOf(false), { turnCheckpoint: checkpoint("web_search") });
    expect(gated).toMatchObject({ graphical: false, cloudComputerWithheld: "hours" });
  });

  it("keeps the computer when it paused in computer mode, for a takeover, or after using it", async () => {
    const reads: string[] = [];
    for (const [hold, saved] of [
      [holdOf(false, reads), { pinnedComputerModels: {} }],
      [holdOf(true, reads), {}],
      [holdOf(false, reads), { turnCheckpoint: checkpoint("shell") }],
    ] as const) {
      expect(await gate(hold, saved)).toMatchObject({
        graphical: true,
        cloudComputerWithheld: false,
      });
    }
    // Its tools stay, so nothing is read: the computer's start refuses it as before.
    expect(reads).toEqual([]);
  });

  it("names attachments without paths, and opens none of them", async () => {
    const gated = await gateRunComputer(holdOf(false), {}, { spaceId: "space-1" }, async () => ({
      ...prepared,
      storedComputer: {},
      attachedFilesPrompt: "Attachments will be copied to these paths: /workspace/report.pdf",
      currentTurnFiles: [{ name: "report.pdf" }],
    }));
    expect(gated.attachedFilesPrompt).toContain('"report.pdf"');
    expect(gated.attachedFilesPrompt).not.toContain("/workspace");
    // A text-only model is not told the image can be opened from the computer.
    expect(gated.currentTurnFiles).toEqual([]);
    expect(filesWithoutComputer(gated.storedComputer)).toBeDefined();
    expect(filesWithoutComputer({})).toBeUndefined();
  });

  it("reads nothing for a bot without a computer row", async () => {
    const reads: string[] = [];
    const gated = await gateRunComputer(holdOf(false, reads), {}, null, async () => prepared);
    expect(gated.cloudComputerWithheld).toBe(false);
    expect(reads).toEqual([]);
  });

  it("is decided again from a checkpoint it cannot read", async () => {
    const gated = await gate(holdOf(false), { turnCheckpoint: "not a checkpoint" });
    expect(gated).toMatchObject({ cloudComputerWithheld: "hours" });
  });
});

describe("what a run without a computer is told", () => {
  it("names only the web tools it was offered", () => {
    const both = noCloudComputerInstruction({
      userComputer: undefined,
      offered: new Set(["web_search", "web_fetch"]),
    });
    expect(both).toContain("web_search");
    expect(both).toContain("web_fetch");
    const search = noCloudComputerInstruction({
      userComputer: undefined,
      offered: new Set(["web_search"]),
    });
    expect(search).toContain("web_search");
    expect(search).not.toContain("web_fetch");
    const fetch = noCloudComputerInstruction({
      userComputer: undefined,
      offered: new Set(["web_fetch"]),
    });
    expect(fetch).toContain("web_fetch");
    expect(fetch).not.toContain("web_search");
    const none = noCloudComputerInstruction({ userComputer: undefined, offered: new Set() });
    expect(none).not.toContain("web_");
    expect(none).toContain(HOW_TO_GET_ONE);
  });

  it("names attachments without paths it cannot open", () => {
    expect(noComputerFilesInstruction([])).toBe("");
    const note = noComputerFilesInstruction(["report.pdf"]);
    expect(note).toContain('"report.pdf"');
    expect(note).not.toContain("/");
  });
});
