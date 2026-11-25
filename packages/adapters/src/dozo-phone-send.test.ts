import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SendLimit from "./dozo-send-limit.js";
import type * as Gate from "./runs/tools/run-tool-gate.js";

// A send to an address the bot learned from the user's phone contacts, through the branded gate
// (dozo/brand/brand.json). Runs on the staged tree. The search goes through the real dispatch
// (its handler, then the run's taint rule); the send through the real gate.

const sends = vi.hoisted(() => [] as string[]);
vi.mock("./dozo-send-limit.js", async (importOriginal) => {
  const real = await importOriginal<typeof SendLimit>();
  return {
    ...real,
    // Upstream's plan for the send, as the daily limit receives it; the limit itself is not here.
    dozoSendLimitGate: async (_ctx: unknown, _call: unknown, plan: string) => {
      sends.push(plan);
      return plan;
    },
  };
});
vi.mock("./runs/tools/run-tool-gate.js", async (importOriginal) => {
  const real = await importOriginal<typeof Gate>();
  const { isPhoneTool, phoneGate } = await import("./dozo-phone.js");
  return {
    ...real,
    auditToolCall: vi.fn(async () => {}),
    // The phone search passes its own approval (the owner allowed this bot before) and runs; the
    // gate's effect bookkeeping is the gate tests' subject. Everything else is the real gate.
    gateToolCall: vi.fn(
      async (
        ctx: Parameters<typeof real.gateToolCall>[0],
        request: Gate.ToolCall & { name: string; args: Record<string, unknown> },
        observer: unknown,
      ) => {
        if (!isPhoneTool(request.name))
          return real.gateToolCall(ctx, request as never, observer as never);
        expect(await phoneGate(ctx, false, request.name, request.args)).toBe("allow");
        return {
          call: {
            name: request.name,
            args: request.args,
            applied: undefined,
            claimedEffect: false,
            connectorCall: { tool: request.name, args: request.args, executionId: "call-0" },
            persistEffectResult: async () => true,
            finish: async (result: unknown) => result,
          },
        };
      },
    ),
  };
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
}));
// Recording the send's effect is where it goes on, asked or not; the test stops there.
vi.mock("./runs/lifecycle/run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => {
    throw new Error("recorded");
  }),
}));

import { createApprovedEffectReplayQueue } from "./approvals/approval-effect.js";
import { PHONE_CONTACTS_SEARCH_TOOL } from "./dozo-phone.tool-definition.js";
import { gateToolCall } from "./runs/tools/run-tool-gate.js";
import type { ToolRequest } from "./runs/tools/run-tool-request.js";
import { applyTool } from "./runs/tools/run-tools.js";

const EMAIL = "ada@example.test";
const MODES = {
  "Never ask": { enabled: false, skipApprovals: true },
  "Auto review": { enabled: true, skipApprovals: false },
  "Always ask": { enabled: false, skipApprovals: false },
};
type Mode = keyof typeof MODES;

/** The owner's own run, alone in their Space, with their phone connected and Contacts on. */
function context(mode: Mode) {
  return {
    deps: {
      userDevices: {
        connected: async () => null,
        pairedSince: async () => null,
        connectedPhone: async () => ({
          deviceId: "phone-1",
          pairedAt: new Date(0),
          onSince: new Date(0),
        }),
        async *request() {
          yield { contacts: [{ name: "Ada Example", values: [EMAIL] }], truncated: false };
        },
      },
      prisma: {
        attempt: { count: async () => 1 },
        $queryRaw: async () => [{ sourced: false }],
        // The bot searched contacts before: the search itself does not ask.
        externalEffect: {
          findFirst: async () => ({ id: "read-before", status: "completed" }),
          count: async () => 0,
        },
        spaceMember: { findFirst: async () => null },
      },
    },
    run: { id: "run-1", userId: "user-1", botId: "bot-1", spaceId: "space-1", trigger: "user" },
    runId: "run-1",
    bot: { id: "bot-1", name: "Helper" },
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun: true, userComputerOwner: "user-1" },
    secrets: [],
    computer: { graphical: false },
    thread: { id: "thread-1", spaceId: "space-1", groupId: null },
    tools: {
      offered: [],
      connector: new Map(),
      connectedPlugins: [],
      disabled: new Set<string>(),
      approvedReplays: createApprovedEffectReplayQueue([]),
    },
    state: {
      tainted: false,
      handedOff: false,
      ownerSettingsRefused: false,
      reply: {},
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () => [],
      loadAutoReviewPreference: async () => MODES[mode],
      // No reviewer is set up: Auto review asks about what it cannot judge.
      loadApprovalModel: async () => ({ primary: null, primarySource: "none", backups: [] }),
      loadTrustedConnectors: async () => new Set(),
      receivedOutsideMessage: async () => false,
    },
  };
}

/** The plan upstream's gate makes for a send of `name` to `to`. */
async function sendPlan(ctx: ReturnType<typeof context>, name: string, to: string) {
  const args = name === "send_email" ? { to, subject: "Hi", text: "Hello" } : { to, text: "Hello" };
  const executionId = JSON.stringify(["pi-tool", "main", "call-2"]);
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
    settingsChange: false,
    ignoresAllowRules: false,
    loginUse: undefined,
  };
  sends.length = 0;
  const outcome = await gateToolCall(ctx as never, request, undefined).then(
    (value) => value,
    (error: Error) => error.message,
  );
  expect(outcome).toBe("recorded");
  return sends[0];
}

beforeEach(() => {
  sends.length = 0;
});

describe("a send to an address from the phone's contacts", () => {
  it.each(
    (Object.keys(MODES) as Mode[]).flatMap((mode) =>
      ["send_email", "message_agent"].map((name) => [mode, name] as const),
    ),
  )("in %s, %s is held exactly as without the search", async (mode, name) => {
    const clean = await sendPlan(context(mode), name, EMAIL);
    const ctx = context(mode);
    const found = await applyTool(
      ctx as never,
      PHONE_CONTACTS_SEARCH_TOOL,
      { query: "Ada", field: "email" },
      JSON.stringify(["pi-tool", "main", "call-1"]),
    );
    expect(found).toEqual({
      contacts: [{ name: "Ada Example", values: [EMAIL] }],
      truncated: false,
    });
    // The phone's answer is outside content: the run is tainted from here on.
    expect(ctx.state.tainted).toBe(true);
    const after = await sendPlan(ctx, name, EMAIL);
    expect(after).toBe(clean);
    // Never ask sends mail without a card (still under the daily limit); the other modes ask,
    // since no reviewer is set up.
    if (name === "send_email") expect(after).toBe(mode === "Never ask" ? "allow" : "ask");
  });
});
