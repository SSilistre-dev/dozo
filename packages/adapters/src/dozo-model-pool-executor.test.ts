import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computers/computer-lifecycle.js";

// Runs on the branded tree only: the brand rules in run-assembly-capabilities.ts and
// run-model-turn.ts pick the connection a run starts on from its pool and hand the pool on.

const pool = vi.hoisted(() => ({ rows: new Map<string, Date | null>() }));

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  readModelPool: vi.fn(async (_prisma: unknown, scope: { credentialIds: string[] }) =>
    scope.credentialIds
      .filter((id) => pool.rows.has(id))
      .map((id) => ({ credentialId: id, resetsAt: pool.rows.get(id) })),
  ),
}));

vi.mock("./computers/computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({ ...input, fence: 7 }),
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
  renewComputerExecutionLease: async () => true,
}));

import { skipsPoolMember } from "./dozo-model-pool.js";
import { createRunExecutor } from "./runs/executor/executor.js";
import { serializeModelSecret } from "./models/model-secret.js";
import { withModelRoles } from "./models/model-roles.test-support.js";

const USER_ID = "user-1";
const MAIN = { provider: "openrouter", modelId: "openai/gpt-4o" };
const stamp = new Date("2026-11-20T00:00:00.000Z");
const HOUR = 60 * 60_000;

const connections = ["a", "b"].map((name, index) => ({
  id: `credential-${name}`,
  userId: USER_ID,
  provider: MAIN.provider,
  label: name,
  secretId: `secret-${name}`,
  supportsImages: false,
  createdAt: new Date(stamp.getTime() + index),
  updatedAt: stamp,
}));
const secrets = connections.map((row) => ({
  id: row.secretId,
  userId: USER_ID,
  spaceId: null,
  kind: "model",
  ciphertext: `cipher-${row.secretId}`,
}));
const plaintexts: Record<string, string> = Object.fromEntries(
  connections.map((row) => [
    row.secretId,
    serializeModelSecret({ kind: "api_key", key: `fake-key-${row.label}` }),
  ]),
);

// The member's main model, on connection a.
const mainRole = {
  userId: USER_ID,
  role: "main",
  position: 0,
  thinkingLevel: null,
  credentialId: "credential-a",
  ...MAIN,
};

/** One unpinned turn for the member. */
async function runTurn() {
  const run: Record<string, unknown> = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: USER_ID,
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const byId = (where: { id?: string; userId?: string }) =>
    connections.find((row) => row.id === where.id && row.userId === where.userId) ?? null;
  const secretById = (args: { where: { id: string } }) =>
    secrets.find((row) => row.id === args.where.id) ?? null;
  const tx = {
    userModelCredential: { findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    userVoiceCredential: { count: vi.fn(async () => 0) },
    $executeRaw: vi.fn(async () => 0),
    secret: { findFirst: vi.fn(async (args: { where: { id: string } }) => secretById(args)) },
  };
  let request: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    yield { type: "done" as const, text: "Done" };
  });
  const prisma = withModelRoles(
    {
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
      // No message sent with an access token is in the bot's chat (dozo-token-run.ts).
      $queryRaw: vi.fn(async () => []),
      user: { findUnique: vi.fn(async () => null) },
      spaceMember: { findUnique: async () => ({ id: "member-1" }) },
      run: {
        findUnique: vi.fn(async () => run),
        findUniqueOrThrow: vi.fn(async () => run),
        findFirst: vi.fn(async () => ({
          bot: { notifyOnFinish: false },
          thread: { groupId: null },
        })),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(run, data);
          return { count: 1 };
        }),
      },
      chatGroup: { findMany: vi.fn(async () => []) },
      bot: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "bot-1",
          name: "Assistant",
          title: "Assistant",
          description: "Test assistant",
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
          computerId: "computer-1",
          computerSwitching: false,
          memoryScope: null,
          computer: { id: "computer-1", scope: "dedicated" },
        })),
        findMany: vi.fn(async () => []),
      },
      attempt: {
        create: vi.fn(async () => ({ id: "attempt-1" })),
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        update: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      thread: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "thread-1",
          groupId: null,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
          nextMessageSeq: 2,
        })),
      },
      message: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => null),
      },
      task: { findUniqueOrThrow: vi.fn(async () => ({ id: "task-1", prompt: "hello" })) },
      computer: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ scope: "dedicated", state: "running" })),
      },
      routine: { findUnique: vi.fn(async () => null) },
      connection: { findMany: vi.fn(async () => []) },
      userModelPreference: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
      },
      userModelCredential: {
        findMany: vi.fn(async ({ where }: { where: { userId?: string } }) =>
          connections.filter((row) => row.userId === where.userId),
        ),
        findFirst: vi.fn(async ({ where }: { where: { id?: string; userId?: string } }) => {
          const row = byId(where);
          return row ? { ...row, userPreferences: [] } : null;
        }),
      },
      secret: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async (args: { where: { id: string } }) => secretById(args)),
      },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      taughtSkill: { findMany: vi.fn(async () => []) },
      vaultCredential: { findMany: vi.fn(async () => []) },
      agentSkill: { findMany: vi.fn(async () => []) },
      scratchpadItem: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
      externalEffect: { findMany: vi.fn(async () => []) },
      userActionApprovalRule: { findMany: vi.fn(async () => []) },
      userActionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
      artifact: { findMany: vi.fn(async () => []) },
    },
    [mainRole],
  );
  Object.assign(tx, {
    $queryRaw: vi.fn(async () => []),
    space: { findUnique: vi.fn(async () => null) },
    run: prisma.run,
  });
  const executor = createRunExecutor({
    prisma,
    billingEnabled: false,
    secretStore: {
      load: vi.fn(async (_ciphertext: string, secretId: string) => plaintexts[secretId]),
      put: vi.fn(async () => ({ ciphertext: "sealed-marker" })),
      delete: vi.fn(async () => undefined),
    },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      listFiles: vi.fn(async () => []),
      readFile: vi.fn().mockRejectedValue(new Error("missing")),
      exportWorkspace: vi.fn(async function* () {
        yield* [];
      }),
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      append: vi.fn(async () => undefined),
      finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun("run-1", "worker-1");
  return request;
}

beforeEach(() => {
  pool.rows = new Map();
});

describe("a run whose main model is on a pooled connection", () => {
  it("runs as before when the connection is not pooled", async () => {
    const request = await runTurn();
    expect(request?.model).toMatchObject({
      ...{ provider: MAIN.provider, id: MAIN.modelId },
      connectionId: "credential-a",
      apiKey: "fake-key-a",
    });
    expect(request?.fallbackModels).toEqual([]);
    expect(
      request && skipsPoolMember({ request, nextIndex: 1 }, { connectionId: "credential-b" }),
    ).toBe(false);
  });

  it("starts on the chosen connection with the next one of its pool as the first backup", async () => {
    pool.rows = new Map([
      ["credential-a", null],
      ["credential-b", null],
    ]);
    const request = await runTurn();
    expect(request?.model).toMatchObject({ connectionId: "credential-a", apiKey: "fake-key-a" });
    expect(request?.fallbackModels).toEqual([
      { provider: MAIN.provider, id: MAIN.modelId, connectionId: "credential-b" },
    ]);
    // Only a connection that ran out may hand the call to it.
    expect(
      request && skipsPoolMember({ request, nextIndex: 1 }, { connectionId: "credential-b" }),
    ).toBe(true);
  });

  it("starts on the next connection while the chosen one rests, and never falls back to it", async () => {
    pool.rows = new Map([
      ["credential-a", new Date(Date.now() + HOUR)],
      ["credential-b", null],
    ]);
    const request = await runTurn();
    expect(request?.model).toMatchObject({ connectionId: "credential-b", apiKey: "fake-key-b" });
    expect(request?.fallbackModels).toEqual([]);
  });

  it("goes back to the chosen connection once its rest is over", async () => {
    pool.rows = new Map([
      ["credential-a", new Date(Date.now() - 1)],
      ["credential-b", null],
    ]);
    const request = await runTurn();
    expect(request?.model).toMatchObject({ connectionId: "credential-a", apiKey: "fake-key-a" });
  });
});
