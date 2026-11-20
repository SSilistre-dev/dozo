import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SendLimit from "./dozo-send-limit.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";

// The branded gate, wired to the daily send limit (dozo/brand/brand.json). Runs on the staged tree.

const limit = vi.hoisted(() => ({
  calls: [] as Array<{ call: Record<string, unknown>; plan: string }>,
  answer: undefined as string | undefined,
}));
vi.mock("./dozo-send-limit.js", async (importOriginal) => {
  const real = await importOriginal<typeof SendLimit>();
  return {
    ...real,
    dozoSendLimitGate: async (
      _ctx: Parameters<typeof real.dozoSendLimitGate>[0],
      call: Parameters<typeof real.dozoSendLimitGate>[1],
      plan: string,
    ) => {
      limit.calls.push({ call, plan });
      return limit.answer ?? plan;
    },
  };
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
}));
// Recording the effect is where the call goes on; the test stops there.
vi.mock("./run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => {
    throw new Error("recorded");
  }),
}));

function gate(
  name: string,
  options: { readOnly?: boolean; approved?: boolean; token?: boolean } = {},
) {
  const args = { to: "someone@example.test", text: "hello" };
  const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
  const request: ToolRequest = {
    name,
    args,
    executionId,
    connectorCall: { tool: name, args, executionId, route: undefined },
    effectRequest: args,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: options.approved ? name : undefined,
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
      // No message sent with an access token reached this run (dozo-token-run.ts).
      prisma: {
        attempt: { count: async () => 1 },
        $queryRaw: async () => [{ sourced: options.token === true }],
      },
    },
    run: { id: "run-1", userId: "user-1", spaceId: "space-1", trigger: "user" },
    runId: "run-1",
    bot: { id: "bot-1", name: "Helper" },
    thread: { id: "thread-1" },
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun: true },
    tools: {
      connector: new Map(
        options.readOnly === undefined ? [] : [[name, { name, readOnly: options.readOnly }]],
      ),
      connectedPlugins: [],
    },
    state: {
      tainted: false,
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () => [],
      loadAutoReviewPreference: async () => ({ enabled: false, skipApprovals: true }),
      loadTrustedConnectors: async () => new Set(),
      receivedOutsideMessage: async () => false,
    },
  };
  return gateToolCall(ctx as never, request, undefined).then(
    (outcome) => outcome,
    (error: Error) => error.message,
  );
}

beforeEach(() => {
  limit.calls.length = 0;
  limit.answer = undefined;
});

describe("gateToolCall: the daily send limit", () => {
  it("hands the limit an ask for a send a token's message asked for, so it takes none of the day's sends", async () => {
    await gate("send_email", { token: true }).catch(() => undefined);
    expect(limit.calls[0]?.plan).toBe("ask");
  });

  it("hands each call and upstream's plan to the limit", async () => {
    expect(await gate("send_email")).toBe("recorded");
    expect(limit.calls).toEqual([
      {
        call: expect.objectContaining({
          name: "send_email",
          viaConnector: false,
          connectorChanges: 0,
          approved: false,
        }),
        plan: "allow",
      },
    ]);
  });

  it("tells a connector action that changes something from one that reads", async () => {
    expect(await gate("chat_post_message", { readOnly: false })).toBe("recorded");
    expect(await gate("chat_list_channels", { readOnly: true })).toBe("recorded");
    expect(
      limit.calls.map(({ call }) => [call.name, call.viaConnector, call.connectorChanges]),
    ).toEqual([
      ["chat_post_message", true, 1],
      ["chat_list_channels", true, 0],
    ]);
  });

  it("marks a call approved on its card", async () => {
    await gate("send_email", { approved: true });
    expect(limit.calls[0]?.call.approved).toBe(true);
  });

  it("acts on the limit's answer", async () => {
    limit.answer = "deny";
    expect(await gate("send_email")).toEqual({
      result: { error: expect.stringContaining("send_email") },
    });
  });
});
