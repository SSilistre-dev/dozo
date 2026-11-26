import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_APPROVAL_DETAIL_LENGTH } from "./approvals/approval-ask.js";
import { dozoTruncate } from "./dozo-approval-cut.js";
import {
  approvalCardCut,
  WHOLE_APPROVAL_ERROR,
  wholeApprovalRefusal,
} from "./dozo-whole-approval.js";
import type { RunContext } from "./runs/assembly/run-context.js";
import { gateToolCall } from "./runs/tools/run-tool-gate.js";
import type { ToolRequest } from "./runs/tools/run-tool-request.js";

// The branded gate and card (dozo/brand/brand.json): a call whose card would be cut is refused
// before anything is asked. Runs on the staged tree.

const stored = vi.hoisted(() => ({ updates: [] as unknown[], paused: [] as unknown[] }));

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
  readDozoCommandRules: vi.fn(async () => []),
}));
vi.mock("./runs/lifecycle/run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => ({
    effect: { id: "effect-1", status: "intended" },
    duplicate: false,
  })),
}));
vi.mock("./runs/lifecycle/run-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  renewRunLease: vi.fn(async () => true),
}));
vi.mock("./runs/assembly/run-context.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  persistTurnCheckpoint: vi.fn(async () => {}),
}));

const SHELL = "user_computer_shell";
const long = "a".repeat(MAX_APPROVAL_DETAIL_LENGTH + 1);

function gate(command: string) {
  const args = { command };
  const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
  const request: ToolRequest = {
    name: SHELL,
    args,
    executionId,
    connectorCall: { tool: SHELL, args, executionId, route: undefined },
    effectRequest: args,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: SHELL,
    fleetSummary: undefined,
    heldForApproval: false,
    purchase: undefined,
    cardUse: undefined,
    settingsChange: false,
    ignoresAllowRules: false,
    loginUse: undefined,
  };
  const ctx = {
    deps: {
      prisma: {
        attempt: { count: async () => 1 },
        $queryRaw: async () => [{ sourced: false }],
        externalEffect: {
          findMany: async () => [],
          updateMany: async (update: unknown) => stored.updates.push(update),
        },
      },
      events: {
        pauseRunForInput: async (input: unknown) => {
          stored.paused.push(input);
          return false;
        },
      },
    },
    run: { id: "run-1", userId: "user-1", spaceId: "space-1", trigger: "user" },
    runId: "run-1",
    workerId: "worker-1",
    fence: 1,
    attempt: { id: "attempt-1" },
    replyMode: "task",
    secrets: [],
    bot: { id: "bot-1", name: "Helper" },
    thread: { id: "thread-1" },
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun: true },
    computer: { checkpoint: { flush: async () => {} } },
    settleRunningHelpers: async () => {},
    tools: { connector: new Map(), connectedPlugins: [] },
    state: {
      tainted: false,
      approval: {},
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () => [],
      loadAutoReviewPreference: async () => ({ enabled: false, skipApprovals: false }),
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
  stored.updates.length = 0;
  stored.paused.length = 0;
});

describe("gateToolCall: a whole approval card", () => {
  it("refuses a command too long to show before any ask is created", async () => {
    expect(await gate(`echo ${long}`)).toEqual({ result: { error: WHOLE_APPROVAL_ERROR } });
    expect(stored.paused).toEqual([]);
    expect(stored.updates).toEqual([
      {
        where: { id: "effect-1", status: "intended" },
        data: { status: "denied", result: { refused: "approval_too_long" } },
      },
    ]);
  });

  it("still asks, with the whole command, when it fits", async () => {
    const command = `echo ${"a".repeat(MAX_APPROVAL_DETAIL_LENGTH - 10)}`;
    // The stubbed pause fails, which ends the call right after the card is built.
    expect(await gate(command)).toContain("Could not pause");
    expect(stored.updates).toEqual([]);
    expect(stored.paused).toEqual([
      expect.objectContaining({ blocks: [expect.objectContaining({ detail: command })] }),
    ]);
  });
});

describe("approvalCardCut", () => {
  it.each(["shell", SHELL])("tells a %s command that fits from one too long", (tool) => {
    expect(approvalCardCut(tool, { command: "ls" }, [])).toBe(false);
    expect(approvalCardCut(tool, { command: long }, [])).toBe(true);
  });

  it("measures the card after secrets are redacted", () => {
    const secret = "s3cret-".repeat(20);
    const command = `echo ${secret} ${"a".repeat(MAX_APPROVAL_DETAIL_LENGTH - 30)}`;
    expect(approvalCardCut(SHELL, { command }, [])).toBe(true);
    expect(approvalCardCut(SHELL, { command }, [secret])).toBe(false);
  });

  it("covers the screen steps, a generic call's details and its title", () => {
    const actions = [{ kind: "type", text: long }];
    expect(approvalCardCut("user_computer_screen", { actions }, [])).toBe(true);
    expect(approvalCardCut("demo_send", { body: long }, [])).toBe(true);
    expect(approvalCardCut("demo_send", { to: long }, [])).toBe(true);
    expect(approvalCardCut("demo_send", { body: "short" }, [])).toBe(false);
  });

  it("keeps a card with its own longer limit asking within it", () => {
    const text = "a".repeat(MAX_APPROVAL_DETAIL_LENGTH + 100);
    const summary = { title: "Set instructions", lines: [text] };
    expect(approvalCardCut("set_child_instructions", {}, [], { summary })).toBe(false);
    expect(approvalCardCut("demo_send", {}, [], { summary })).toBe(true);
  });
});

describe("wholeApprovalRefusal", () => {
  it("refuses without an effect to mark, and leaves a card that fits alone", async () => {
    const ctx = {
      secrets: [],
      bot: { id: "bot-1", name: "Helper" },
      run: { id: "run-1", spaceId: "space-1" },
      runId: "run-1",
      thread: { id: "thread-1" },
      deps: { prisma: {} },
    } as unknown as RunContext;
    expect(
      await wholeApprovalRefusal(ctx, { name: SHELL, args: { command: "ls" } }, undefined),
    ).toBe(undefined);
    // Neither an effect nor a store to write to: the refusal is only the model's answer.
    const refused = await wholeApprovalRefusal(
      ctx,
      { name: SHELL, args: { command: long } },
      undefined,
    );
    expect(refused).toEqual({ error: WHOLE_APPROVAL_ERROR });
  });
});

describe("dozoTruncate", () => {
  const slice = (text: string, length: number) => text.slice(0, length);

  it("keeps text that fits and cuts, with an ellipsis, text that does not", () => {
    expect(dozoTruncate("abc", 3, slice)).toBe("abc");
    expect(dozoTruncate("abcd", 3, slice)).toBe("abc…");
  });
});
