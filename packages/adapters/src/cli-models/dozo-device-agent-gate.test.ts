import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import type * as Db from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovedEffectReplayQueue } from "../approvals/approval-effect.js";
import type { HostComputerRequest } from "../computers/host/host-computer-protocol.js";
import { markReadOutsideContent } from "../runs/assembly/run-context.js";
import { applyTool } from "../runs/tools/run-tools.js";
import { cliModelRuntime } from "./dozo-cli-runtime.js";

// What an agent on the person's computer asks of the bot's tools goes through the run's own
// applyTool, with the real gate: here the real gate decides, and only the place an approval card
// would be written is stood in for (as run-tool-gate.test.ts does).

const plans = vi.hoisted(() => [] as string[]);
vi.mock("@rakazo/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return {
    ...core,
    planActionGate: (input: Parameters<typeof core.planActionGate>[0]) => {
      const plan = core.planActionGate(input);
      plans.push(plan);
      return plan;
    },
  };
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
}));
vi.mock("../runs/lifecycle/run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => {
    throw new Error("the approval card is written here");
  }),
}));

const AGENT = "antigravity-agent";

function context(rule?: "deny") {
  return {
    deps: {
      prisma: { attempt: { count: async () => 1 }, $queryRaw: async () => [{ sourced: false }] },
    },
    run: { id: "run-1", userId: "ada", spaceId: "space-1", trigger: "user" },
    runId: "run-1",
    bot: { id: "bot-1", userId: "ada", name: "Helper" },
    thread: { id: "thread-1", groupId: null },
    context: { signal: new AbortController().signal },
    secrets: [],
    source: { ownerStartedRun: true, messagingChannelRun: false },
    tools: {
      offered: [{ name: "save_memory" }],
      disabled: new Set<string>(),
      approvedReplays: createApprovedEffectReplayQueue([]),
      connector: new Map(),
      connectedPlugins: [],
    },
    computer: { pageBrowserAllowed: true, acceptsImages: true },
    state: {
      tainted: false,
      earlierAttempt: undefined,
      handedOff: false,
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      receivedOutsideMessage: async () => false,
      loadTrustedConnectors: async () => new Set<string>(),
      routineNamesNewSite: async () => false,
      loadApprovalRules: async () =>
        rule ? [{ effect: rule, matchKind: "tool", matchValue: "save_memory" }] : [],
      loadAutoReviewPreference: async () => ({ enabled: false, skipApprovals: false }),
    },
  };
}

/** The agent asks for one tool of the bot's, once the turn started. */
async function agentAsks(ctx: ReturnType<typeof context>, name: string) {
  const sent: HostComputerRequest[] = [];
  const frames = [
    { type: "started" },
    { type: "toolCall", callId: "c1", name, args: { content: "a note" } },
    { type: "done" },
  ];
  const gateway = {
    async *request<T>(_user: string, request: HostComputerRequest): AsyncIterable<T> {
      sent.push(request);
      if (request.method === "agentTurn") for (const frame of frames) yield frame as T;
    },
  };
  const next = {
    describe: () => ({}) as ReturnType<AgentRuntime["describe"]>,
    abort: async () => undefined,
    run: async function* () {},
  } satisfies AgentRuntime;
  const prisma = {
    run: {
      findUnique: async () => ({
        trigger: "user",
        userId: "ada",
        bot: { userId: "ada" },
        sourceMessage: { authorUserId: "ada", role: "user" },
      }),
    },
    userModelCredential: { findFirst: async () => ({ id: "conn-1" }) },
    userDevice: {
      findMany: async () => [{ id: "dev-1", name: "Laptop", connections: [{ deviceId: "dev-1" }] }],
    },
    $queryRaw: async (strings: TemplateStringsArray) =>
      strings.join("?").includes("dozo_device_capabilities")
        ? [{ capabilities: [`agent:${AGENT}`] }]
        : [{ sourced: false }],
  } as unknown as PrismaClient;
  const runtime = cliModelRuntime(
    { defaultProvider: "openrouter", defaultModel: "m", deploymentModelConfigured: false },
    next,
    { prisma, userDevices: gateway },
  );
  const request = {
    botId: "bot-1",
    threadId: "thread-1",
    runId: "run-1",
    prompt: "Remember this",
    instructions: "",
    history: [],
    tools: [{ name, description: "", inputSchema: { type: "object" } }],
    model: {
      provider: AGENT,
      id: "default",
      apiKey: "dozo-cli-account:device:dev-1",
      connectionId: "conn-1",
    },
    // The run's own executor and its marking of outside content, as the executor hands them over.
    executeTool: (tool: string, args: Record<string, unknown>, id: string) =>
      applyTool(ctx as never, tool, args, id, undefined, undefined),
    readOutsideContent: () => markReadOutsideContent(ctx as never),
  } as unknown as AgentRunRequest;
  for await (const _ of runtime.run(request, {})) {
    // The run's events are not what is looked at here.
  }
  return sent.find((entry) => entry.method === "agentToolResult") as
    | (HostComputerRequest & { text: string; isError: boolean })
    | undefined;
}

describe("a bot tool the agent on the person's computer asks for", () => {
  beforeEach(() => {
    plans.length = 0;
    const dir = mkdtempSync(join(tmpdir(), "dozo-agents-"));
    writeFileSync(join(dir, "dozo-agent-tools"), `${AGENT}\n`);
    vi.stubEnv("DATA_DIR", dir);
  });

  it("is judged as a run that read outside content: a memory write asks, and the card is written", async () => {
    const ctx = context();
    const answer = await agentAsks(ctx, "save_memory");
    expect(ctx.state.tainted).toBe(true);
    expect(plans).toEqual(["ask"]);
    expect(answer).toMatchObject({ isError: true });
    expect(answer?.text).toContain("the approval card is written here");
  });

  it("is refused under a block rule, with the gate's own words", async () => {
    const blocked = await agentAsks(context("deny"), "save_memory");
    expect(plans).toEqual(["deny"]);
    expect(blocked?.isError).toBe(false);
    expect(blocked?.text).toContain("is blocked in this space");
  });
});
