import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TokenRun from "./dozo-token-run.js";

// The branded gate (dozo/brand/brand.json) with the phone tool in it. Runs on the staged tree.

const plans = vi.hoisted(() => [] as string[]);
vi.mock("./dozo-token-run.js", async (importOriginal) => {
  const real = await importOriginal<typeof TokenRun>();
  return {
    ...real,
    // What the user's-device gate decided, before a token's run would turn it into an ask.
    dozoTokenRunPlan: async (...input: Parameters<typeof real.dozoTokenRunPlan>) => {
      plans.push(input[2]);
      return real.dozoTokenRunPlan(...input);
    },
  };
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
}));
// Recording the effect is where an allowed or asked call goes on; the test stops there.
vi.mock("./run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => {
    throw new Error("recorded");
  }),
}));

import { withoutCloudComputerTools } from "./dozo-no-computer.js";
import { offerPhoneTools, phoneCalendarRead, phoneGate } from "./dozo-phone.js";
import { PHONE_CALENDAR_READ_TOOL } from "./dozo-phone.tool-definition.js";
import { buildApprovalAskBlock, userComputerGate } from "./dozo-user-computer-gate.js";
import type { RunContext } from "./run-context.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { READ_ONLY_AGENT_TOOLS } from "./run-tool-selection.js";
import { userComputerOwner } from "./run-tools-user-computer.js";

const RANGE = { from: "2026-11-22T00:00:00+03:00", to: "2026-11-29T00:00:00+03:00" };
const MODES = {
  "Never ask": { enabled: false, skipApprovals: true },
  "Auto review": { enabled: true, skipApprovals: false },
  "Always ask": { enabled: false, skipApprovals: false },
};

function context(
  options: {
    owner?: string | undefined;
    consent?: boolean;
    token?: boolean;
    mode?: keyof typeof MODES;
  } = {},
) {
  const requests: unknown[] = [];
  const userDevices = {
    connected: async () => null,
    pairedSince: async () => null,
    connectedPhone: async () => ({ deviceId: "phone-1", pairedAt: new Date(0) }),
    async *request(...input: unknown[]) {
      requests.push(input);
      yield { events: [], truncated: false };
    },
  };
  const findFirst = vi.fn(async () => (options.consent ? { id: "approved-before" } : null));
  const ctx = {
    deps: {
      userDevices,
      prisma: {
        attempt: { count: async () => 1 },
        $queryRaw: async () => [{ sourced: options.token === true }],
        externalEffect: { findFirst, updateMany: async () => ({ count: 1 }) },
      },
    },
    run: { id: "run-1", userId: "user-1", botId: "bot-1", spaceId: "space-1", trigger: "user" },
    runId: "run-1",
    bot: { id: "bot-1", name: "Helper" },
    thread: { id: "thread-1" },
    context: { signal: new AbortController().signal },
    source: {
      ownerStartedRun: true,
      userComputerOwner: "owner" in options ? options.owner : "user-1",
    },
    secrets: [],
    computer: { graphical: false },
    tools: { connector: new Map(), connectedPlugins: [], disabled: new Set<string>() },
    state: {
      tainted: false,
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () => [],
      loadAutoReviewPreference: async () => MODES[options.mode ?? "Never ask"],
      // No reviewer is set up: Auto review would ask about anything it cannot judge.
      loadApprovalModel: async () => ({ primary: null, primarySource: "none", backups: [] }),
      loadTrustedConnectors: async () => new Set(),
      receivedOutsideMessage: async () => false,
    },
  };
  return { ctx: ctx as unknown as RunContext, findFirst, requests };
}

function gate(ctx: RunContext, args: Record<string, unknown> = { ...RANGE }) {
  const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
  const name = PHONE_CALENDAR_READ_TOOL;
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
  return gateToolCall(ctx, request, undefined).then(
    (outcome) => outcome,
    (error: Error) => error.message,
  );
}

beforeEach(() => {
  plans.length = 0;
});

describe("the phone's approval", () => {
  it.each(Object.keys(MODES) as Array<keyof typeof MODES>)(
    "asks a bot's first read and allows it once allowed, in %s",
    async (mode) => {
      expect(await gate(context({ mode }).ctx)).toBe("recorded");
      expect(await gate(context({ mode, consent: true }).ctx)).toBe("recorded");
      expect(plans).toEqual(["ask", "allow"]);
    },
  );

  it("is not a read the gate lets through without an effect", () => {
    expect(READ_ONLY_AGENT_TOOLS.has(PHONE_CALENDAR_READ_TOOL)).toBe(false);
  });

  it("holds consent to this bot and person, since the phone was paired", async () => {
    const { ctx, findFirst } = context();
    await phoneGate(ctx, false, { ...RANGE });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        spaceId: "space-1",
        kind: PHONE_CALENDAR_READ_TOOL,
        status: { in: ["approved", "executing", "completed", "uncertain"] },
        createdAt: { gte: new Date(0) },
        run: { userId: "user-1", botId: "bot-1" },
      },
      select: { id: true },
    });
  });

  it("refuses a block, a token's run and a run that is not the owner's, even once allowed", async () => {
    expect(
      await userComputerGate(context({ consent: true }).ctx, true, PHONE_CALENDAR_READ_TOOL, {}),
    ).toBe("deny");
    const token = context({ consent: true, token: true });
    expect(await gate(token.ctx)).not.toBe("recorded");
    expect(plans).toEqual(["deny"]);
    expect(await phoneGate(context({ consent: true, owner: undefined }).ctx, false, {})).toBe(
      "deny",
    );
  });

  it("shows what it reads and the range on its card, with Allow and Deny", () => {
    expect(
      buildApprovalAskBlock(
        "effect-1",
        PHONE_CALENDAR_READ_TOOL,
        { ...RANGE, query: "dentist" },
        [],
      ),
    ).toEqual({
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Let this bot read your phone's calendar?",
      detail: `${RANGE.from} – ${RANGE.to}\ndentist`,
      status: "pending",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(buildApprovalAskBlock("effect-1", PHONE_CALENDAR_READ_TOOL, {}, [])).not.toHaveProperty(
      "detail",
    );
  });
});

describe("who a run reaches the phone for", () => {
  const owner = "user-1";
  const cases = {
    "the owner's own chat": { trigger: "user", role: "user", runUser: owner, channel: false },
    "a follow-up of the owner": {
      trigger: "follow_up",
      role: "user",
      runUser: owner,
      channel: false,
    },
    "another member's run": { trigger: "user", role: "user", runUser: "user-2", channel: false },
    "a group chat run another member started": {
      trigger: "follow_up",
      role: "user",
      runUser: "user-2",
      channel: false,
    },
    "a routine": { trigger: "routine", role: "user", runUser: owner, channel: false },
    "a webhook": { trigger: "webhook", role: "user", runUser: owner, channel: false },
    "a messaging-channel stranger": {
      trigger: "user",
      role: "user",
      runUser: owner,
      channel: true,
    },
    "another bot's message": {
      trigger: "bot_message",
      role: "user",
      runUser: owner,
      channel: false,
    },
  };

  it.each(Object.entries(cases))("%s", async (label, input) => {
    const reached = userComputerOwner({
      trigger: input.trigger,
      sourceRole: input.role,
      messagingChannelRun: input.channel,
      runUserId: input.runUser,
      botUserId: owner,
    });
    const allowed = label.startsWith("the owner") || label.startsWith("a follow-up");
    expect(reached).toBe(allowed ? owner : undefined);
    const run = context({ owner: reached, consent: true });
    // Assembly offers it only to a run that reaches its owner (run-assembly-capabilities.ts).
    const off = withoutCloudComputerTools(new Set(), false);
    if (reached) await offerPhoneTools(run.ctx.deps, run.ctx.run, reached, off, null);
    expect(off.has(PHONE_CALENDAR_READ_TOOL)).toBe(!allowed);
    const args = { ...RANGE };
    expect(await phoneGate(run.ctx, false, args)).toBe(allowed ? "allow" : "deny");
    const result = await phoneCalendarRead(run.ctx, {
      name: PHONE_CALENDAR_READ_TOOL,
      args,
      applied: undefined,
      claimedEffect: false,
      finish: async (value: unknown) => value,
      persistEffectResult: async () => true,
    } as never);
    expect(run.requests).toHaveLength(allowed ? 1 : 0);
    if (!allowed) expect(result).toHaveProperty("error");
  });
});
