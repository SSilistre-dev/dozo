import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import {
  CLOUD_COMPUTER_TOOL_NAMES,
  cloudComputerWithheld,
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
  | { kind: "free" }
  /** Premium, with this many computer hours already used this period. */
  | { kind: "premium"; usedHours: number };

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
          status: "active",
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
  };
  const models: Record<string, Record<string, (...args: never[]) => unknown>> = {
    spaceMember: {
      findUnique: () => ({ id: "member-1", member: { role: "owner", organization } }),
    },
    space: { findUnique: () => ({ organizationId: "org-1" }) },
    organization: { findUnique: () => organization },
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
}) {
  const reads: string[] = [];
  const { prisma, run } = fakePrisma(options.plan, reads);
  let request: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (sent: AgentRunRequest) {
    request = sent;
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

describe("a paused turn", () => {
  it("resumes with the tools it started with, without reading the allowance", async () => {
    const reads: string[] = [];
    const { prisma } = fakePrisma({ kind: "free" }, reads);
    const deps = { prisma, sandbox: {}, billingEnabled: true } as unknown as Parameters<
      typeof cloudComputerWithheld
    >[0];
    const computer = { spaceId: "space-1", kind: "docker" };
    expect(await cloudComputerWithheld(deps, computer, true)).toBe(false);
    expect(reads).toEqual([]);
    expect(await cloudComputerWithheld(deps, computer, false)).toBe(true);
  });
});

describe("the prepared computer of a run without one", () => {
  it("is not graphical and names attachments without paths", async () => {
    const { prisma } = fakePrisma({ kind: "free" }, []);
    const hold = {
      deps: { prisma, sandbox: {}, billingEnabled: true },
      takeover: { heldForTakeover: false },
    } as unknown as Parameters<typeof gateRunComputer>[0];
    const prepared = {
      storedComputer: { spaceId: "space-1" },
      computerKind: "docker",
      graphical: true,
      attachedFilesPrompt: "Attachments will be copied to these paths: /home/report.pdf",
      currentTurnFiles: [{ name: "report.pdf" }],
    };
    const gated = await gateRunComputer(hold, { storedTurnCheckpoint: false }, prepared);
    expect(gated).toMatchObject({ graphical: false, cloudComputerWithheld: true });
    expect(gated.attachedFilesPrompt).toContain('"report.pdf"');
    expect(gated.attachedFilesPrompt).not.toContain("/home");
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
