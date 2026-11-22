import type * as Core from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";

// The branded gate, wired to skillWriteNeedsApproval (dozo/brand/brand.json). Runs on the
// staged tree.

const seen = vi.hoisted(() => ({ plans: [] as string[], blocks: [] as unknown[] }));
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
}));
vi.mock("./run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => ({
    duplicate: false,
    effect: { id: "effect-1", status: "intended" },
  })),
}));
vi.mock("./run-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  renewRunLease: vi.fn(async () => true),
}));
vi.mock("./run-context.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  persistTurnCheckpoint: vi.fn(async () => {}),
}));

type Mode = "ask" | "auto" | "never";

function gate(
  name: string,
  options: { tainted?: boolean; mode?: Mode; alwaysAllow?: boolean; ownerStarted?: boolean } = {},
) {
  const mode = options.mode ?? "ask";
  const args = { name: "Invoices", description: "Forward invoices", content: "Do it" };
  const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
  const request: ToolRequest = {
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
  const ctx = {
    deps: {
      prisma: {
        attempt: { count: async () => 1 },
        externalEffect: { findMany: async () => [] },
        // No message sent with an access token reached this run (dozo-token-run.ts).
        $queryRaw: async () => [{ sourced: false }],
      },
      events: {
        // The card is what the test reads; a refused pause ends the call there.
        pauseRunForInput: async (input: { blocks: unknown[] }) => {
          seen.blocks.push(...input.blocks);
          return false;
        },
      },
    },
    run: {
      id: "run-1",
      userId: "user-1",
      spaceId: "space-1",
      threadId: "thread-1",
      trigger: options.ownerStarted === false ? "routine" : "user",
    },
    runId: "run-1",
    attempt: { id: "attempt-1" },
    bot: { id: "bot-1", name: "Helper" },
    thread: { id: "thread-1" },
    secrets: [],
    computer: { checkpoint: { flush: async () => {} } },
    settleRunningHelpers: async () => {},
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun: options.ownerStarted ?? true },
    tools: { connector: new Map(), connectedPlugins: [] },
    state: {
      tainted: Boolean(options.tainted),
      approval: {},
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () =>
        options.alwaysAllow
          ? [{ effect: "always_allow", matchKind: "tool", matchValue: name }]
          : [],
      loadAutoReviewPreference: async () => ({
        enabled: mode === "auto",
        skipApprovals: mode === "never",
      }),
      loadApprovalModel: async () => ({ primary: null, primarySource: null, backups: [] }),
      receivedOutsideMessage: async () => false,
    },
  };
  return gateToolCall(ctx as never, request, undefined).then(
    (outcome) => outcome,
    (error: Error) => error.message,
  );
}

const actionIds = () =>
  (seen.blocks.at(-1) as { actions?: Array<{ id: string }> } | undefined)?.actions?.map(
    (action) => action.id,
  );

beforeEach(() => {
  seen.plans.length = 0;
  seen.blocks.length = 0;
});

describe("gateToolCall: a skill written in a tainted run", () => {
  it.each(["skill_create", "skill_update"])(
    "%s asks a person, without offering Always allow",
    async (name) => {
      await gate(name, { tainted: true });
      expect(seen.plans).toEqual(["ask"]);
      expect(actionIds()).toEqual(["allow", "deny"]);
    },
  );

  it("asks in Auto and over an Always allow rule", async () => {
    for (const options of [
      { mode: "auto" as const },
      { alwaysAllow: true },
      { mode: "auto" as const, alwaysAllow: true },
    ]) {
      seen.plans.length = 0;
      await gate("skill_create", { tainted: true, ...options });
      expect(seen.plans).toEqual(["ask"]);
    }
  });

  it("is refused in Never ask with the existing message", async () => {
    for (const ownerStarted of [true, false]) {
      expect(await gate("skill_create", { tainted: true, mode: "never", ownerStarted })).toEqual({
        result: { error: expect.stringContaining("this space never asks") },
      });
    }
    expect(seen.plans).toEqual(["deny", "deny"]);
    expect(seen.blocks).toEqual([]);
  });

  it("leaves reading and deleting a skill as they were", async () => {
    await gate("skill_read", { tainted: true });
    await gate("skill_delete", { tainted: true, mode: "never" });
    expect(seen.plans).toEqual(["allow", "allow"]);
  });
});

describe("gateToolCall: a skill written in the owner's clean run", () => {
  it.each(["ask", "auto", "never"] as const)("runs freely in %s", async (mode) => {
    const outcome = await gate("skill_create", { mode });
    expect(seen.plans).toEqual(["allow"]);
    expect(outcome).toEqual({ call: expect.objectContaining({ name: "skill_create" }) });
    expect(seen.blocks).toEqual([]);
  });
});
