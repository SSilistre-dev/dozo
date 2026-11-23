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
import { offerPhoneTools, phoneGate, phoneRead } from "./dozo-phone.js";
import {
  PHONE_CALENDAR_CREATE_TOOL,
  PHONE_CALENDAR_READ_TOOL,
  PHONE_CONTACTS_SEARCH_TOOL,
  PHONE_LOCATION_TOOL,
  PHONE_REMINDER_CREATE_TOOL,
  PHONE_REMINDERS_READ_TOOL,
  phoneCalendarCreateTool,
  phoneCalendarReadTool,
  phoneContactsSearchTool,
  phoneLocationTool,
  phoneReminderCreateTool,
  phoneRemindersReadTool,
} from "./dozo-phone.tool-definition.js";
import { buildApprovalAskBlock, userComputerGate } from "./dozo-user-computer-gate.js";
import { toAgentTool } from "./pi-runtime-tools.js";
import type { RunContext } from "./run-context.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";
import { READ_ONLY_AGENT_TOOLS } from "./run-tool-selection.js";
import { userComputerOwner } from "./run-tools-user-computer.js";

const RANGE = { from: "2026-11-22T00:00:00+03:00", to: "2026-11-29T00:00:00+03:00" };
const SOON = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
const SOON_END = new Date(Date.parse(SOON) + 60 * 60 * 1000).toISOString();
/** Each phone tool, a call it can make and its handler. */
const TOOLS = {
  [PHONE_CALENDAR_READ_TOOL]: { args: RANGE, handler: phoneRead },
  [PHONE_CONTACTS_SEARCH_TOOL]: {
    args: { query: "Ada", field: "phone" },
    handler: phoneRead,
  },
  [PHONE_LOCATION_TOOL]: { args: { precision: "approximate" }, handler: phoneRead },
  [PHONE_REMINDERS_READ_TOOL]: { args: { include_done: false }, handler: phoneRead },
  [PHONE_CALENDAR_CREATE_TOOL]: {
    args: { title: "Lunch", start: SOON, end: SOON_END },
    handler: phoneRead,
  },
  [PHONE_REMINDER_CREATE_TOOL]: { args: { title: "Call Ada" }, handler: phoneRead },
};
/** The tools whose every call asks, so a run reaches the phone only on the call's own card. */
const EVERY_CALL_ASKS: string[] = [
  PHONE_LOCATION_TOOL,
  PHONE_CALENDAR_CREATE_TOOL,
  PHONE_REMINDER_CREATE_TOOL,
];
const WRITE_TOOLS = [PHONE_CALENDAR_CREATE_TOOL, PHONE_REMINDER_CREATE_TOOL] as const;
const TOOL_NAMES = Object.keys(TOOLS) as Array<keyof typeof TOOLS>;
const MODES = {
  "Never ask": { enabled: false, skipApprovals: true },
  "Auto review": { enabled: true, skipApprovals: false },
  "Always ask": { enabled: false, skipApprovals: false },
};

function context(
  options: {
    owner?: string | undefined;
    consent?: boolean;
    /** The owner allowed this very call on its card. */
    card?: boolean;
    token?: boolean;
    mode?: keyof typeof MODES;
    tainted?: boolean;
    groupId?: string;
  } = {},
) {
  const requests: unknown[] = [];
  const userDevices = {
    connected: async () => null,
    pairedSince: async () => null,
    // Paired at 0; this kind's switch was last turned on at 5.
    connectedPhone: async () => ({
      deviceId: "phone-1",
      pairedAt: new Date(0),
      onSince: new Date(5),
    }),
    async *request(...input: unknown[]) {
      requests.push(input);
      yield { events: [], truncated: false };
    },
  };
  // An earlier completed read, or this call's approved card, when given; a tainted run's gate
  // does not ask for the first, nor does a location read.
  const findFirst = vi.fn(async ({ where }: { where: { OR: Array<{ status: string }> } }) =>
    options.card
      ? { id: "card", status: "approved" }
      : options.consent && where.OR.some((clause) => clause.status === "completed")
        ? { id: "read-before", status: "completed" }
        : null,
  );
  const ctx = {
    deps: {
      userDevices,
      prisma: {
        attempt: { count: async () => 1 },
        $queryRaw: async () => [{ sourced: options.token === true }],
        externalEffect: {
          findFirst,
          updateMany: async () => ({ count: 1 }),
          count: async () => 0,
        },
        spaceMember: { findFirst: async () => null },
      },
    },
    run: { id: "run-1", userId: "user-1", botId: "bot-1", spaceId: "space-1", trigger: "user" },
    runId: "run-1",
    bot: { id: "bot-1", name: "Helper" },
    context: { signal: new AbortController().signal },
    source: {
      ownerStartedRun: true,
      userComputerOwner: "owner" in options ? options.owner : "user-1",
    },
    secrets: [],
    computer: { graphical: false },
    thread: { id: "thread-1", spaceId: "space-1", groupId: options.groupId ?? null },
    tools: { connector: new Map(), connectedPlugins: [], disabled: new Set<string>() },
    state: {
      tainted: Boolean(options.tainted),
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

function gate(
  ctx: RunContext,
  args: Record<string, unknown> = { ...RANGE },
  name: string = PHONE_CALENDAR_READ_TOOL,
) {
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

  it("asks every read once outside content entered the run, in Never ask too", async () => {
    expect(await gate(context({ consent: true, tainted: true }).ctx)).toBe("recorded");
    expect(plans).toEqual(["ask"]);
  });

  it("refuses the owner's own run in a group chat, allowed or not, in every mode", async () => {
    for (const mode of Object.keys(MODES) as Array<keyof typeof MODES>)
      expect(await gate(context({ mode, consent: true, groupId: "group-1" }).ctx)).not.toBe(
        "recorded",
      );
    expect(plans).toEqual(["deny", "deny", "deny"]);
  });

  it("is not a read the gate lets through without an effect", () => {
    expect(READ_ONLY_AGENT_TOOLS.has(PHONE_CALENDAR_READ_TOOL)).toBe(false);
  });

  it("holds consent to this bot and person, since this kind was last turned on", async () => {
    const { ctx, findFirst } = context();
    await phoneGate(ctx, false, PHONE_CALENDAR_READ_TOOL, { ...RANGE });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        spaceId: "space-1",
        kind: PHONE_CALENDAR_READ_TOOL,
        createdAt: { gte: new Date(5) },
        run: { userId: "user-1", botId: "bot-1" },
        OR: [
          { status: "completed" },
          { status: "approved", runId: "run-1", request: { equals: RANGE } },
        ],
      },
      select: { id: true, status: true },
    });
  });

  it("refuses a block, a token's run and a run that is not the owner's, even once allowed", async () => {
    expect(
      await userComputerGate(context({ consent: true }).ctx, true, PHONE_CALENDAR_READ_TOOL, {}),
    ).toBe("deny");
    const token = context({ consent: true, token: true });
    expect(await gate(token.ctx)).not.toBe("recorded");
    expect(plans).toEqual(["deny"]);
    for (const name of TOOL_NAMES)
      expect(
        await phoneGate(context({ consent: true, owner: undefined }).ctx, false, name, {}),
      ).toBe("deny");
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

describe("contacts and location through the gate", () => {
  const NEW_TOOLS = [PHONE_CONTACTS_SEARCH_TOOL, PHONE_LOCATION_TOOL] as const;

  it.each(Object.keys(MODES) as Array<keyof typeof MODES>)(
    "asks every location read, approximate too, in %s",
    async (mode) => {
      const args = TOOLS[PHONE_LOCATION_TOOL].args;
      expect(
        await gate(context({ mode, consent: true }).ctx, { ...args }, PHONE_LOCATION_TOOL),
      ).toBe("recorded");
      expect(plans).toEqual(["ask"]);
    },
  );

  it.each(
    (Object.keys(MODES) as Array<keyof typeof MODES>).map(
      (mode) => [PHONE_CONTACTS_SEARCH_TOOL, mode] as const,
    ),
  )("%s asks a bot's first read and allows it once allowed, in %s", async (name, mode) => {
    const args = TOOLS[name].args;
    expect(await gate(context({ mode }).ctx, { ...args }, name)).toBe("recorded");
    expect(await gate(context({ mode, consent: true }).ctx, { ...args }, name)).toBe("recorded");
    expect(await gate(context({ consent: true, tainted: true }).ctx, { ...args }, name)).toBe(
      "recorded",
    );
    expect(plans).toEqual(["ask", "allow", "ask"]);
  });

  it.each(NEW_TOOLS)("%s is refused in a group, a token's run and on a block", async (name) => {
    const args = TOOLS[name].args;
    expect(
      await gate(context({ consent: true, groupId: "group-1" }).ctx, { ...args }, name),
    ).not.toBe("recorded");
    expect(await gate(context({ consent: true, token: true }).ctx, { ...args }, name)).not.toBe(
      "recorded",
    );
    expect(plans).toEqual(["deny", "deny"]);
    expect(await userComputerGate(context({ consent: true }).ctx, true, name, { ...args })).toBe(
      "deny",
    );
  });

  it("asks for a precise location every time, in Never ask too", async () => {
    expect(
      await gate(context({ consent: true }).ctx, { precision: "precise" }, PHONE_LOCATION_TOOL),
    ).toBe("recorded");
    expect(plans).toEqual(["ask"]);
  });

  it("shows each tool's question on its card", () => {
    expect(
      buildApprovalAskBlock("e", PHONE_CONTACTS_SEARCH_TOOL, { query: "Ada", field: "phone" }, []),
    ).toMatchObject({
      text: "Let this bot look up someone in your phone's contacts?",
      detail: "Ada\nPhone numbers",
      detailFormat: "code",
    });
    expect(buildApprovalAskBlock("e", PHONE_LOCATION_TOOL, {}, [])).toMatchObject({
      text: "Let this bot see your phone's approximate location?",
    });
  });
});

describe("a model turn with several phone calls", () => {
  it.each(TOOL_NAMES)("runs %s one call at a time", (name) => {
    const tool = [
      phoneCalendarReadTool,
      phoneContactsSearchTool,
      phoneLocationTool,
      phoneRemindersReadTool,
      phoneCalendarCreateTool,
      phoneReminderCreateTool,
    ].find((definition) => definition.name === name)!;
    expect(toAgentTool(tool, {} as never, name).executionMode).toBe("sequential");
  });
});

describe("a helper", () => {
  it.each(TOOL_NAMES)("cannot use %s: refused before any card", async (name) => {
    const { ctx } = context({ consent: true });
    const request = (agent: string) =>
      ({
        name,
        args: { ...TOOLS[name].args },
        executionId: JSON.stringify(["pi-tool", agent, "call-1"]),
        nextApprovedTool: undefined,
      }) as unknown as ToolRequest;
    expect(await prepareToolRequest(ctx, request("helper-1"))).toMatchObject({
      error: "Helpers cannot use the user's phone.",
    });
    expect(await prepareToolRequest(ctx, request("main"))).toBeUndefined();
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

  it.each(
    Object.entries(cases).flatMap(([label, input]) =>
      TOOL_NAMES.map((name) => [label, name, input] as const),
    ),
  )("%s, %s", async (label, name, input) => {
    const reached = userComputerOwner({
      trigger: input.trigger,
      sourceRole: input.role,
      messagingChannelRun: input.channel,
      runUserId: input.runUser,
      botUserId: owner,
    });
    const allowed = label.startsWith("the owner") || label.startsWith("a follow-up");
    expect(reached).toBe(allowed ? owner : undefined);
    // Location reads each ask: the owner allowed this one on its card.
    const run = context({ owner: reached, consent: true, card: EVERY_CALL_ASKS.includes(name) });
    // Assembly offers it only to a run that reaches its owner (run-assembly-capabilities.ts).
    const off = withoutCloudComputerTools(new Set(), false);
    if (reached)
      await offerPhoneTools(run.ctx.deps, run.ctx.run, run.ctx.thread, reached, off, null);
    expect(off.has(name)).toBe(!allowed);
    const args = { ...TOOLS[name].args };
    expect(await phoneGate(run.ctx, false, name, args)).toBe(allowed ? "allow" : "deny");
    const result = await TOOLS[name].handler(run.ctx, {
      name,
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

describe("writes to the phone through the gate", () => {
  it.each(
    WRITE_TOOLS.flatMap((name) =>
      (Object.keys(MODES) as Array<keyof typeof MODES>).map((mode) => [name, mode] as const),
    ),
  )("%s asks every call, after earlier writes too, in %s", async (name, mode) => {
    const args = TOOLS[name].args;
    expect(await gate(context({ mode }).ctx, { ...args }, name)).toBe("recorded");
    expect(await gate(context({ mode, consent: true }).ctx, { ...args }, name)).toBe("recorded");
    expect(plans).toEqual(["ask", "ask"]);
  });

  it.each(WRITE_TOOLS)("%s is refused in a group, a token's run and on a block", async (name) => {
    const args = TOOLS[name].args;
    expect(await gate(context({ card: true, groupId: "group-1" }).ctx, { ...args }, name)).not.toBe(
      "recorded",
    );
    expect(await gate(context({ card: true, token: true }).ctx, { ...args }, name)).not.toBe(
      "recorded",
    );
    expect(plans).toEqual(["deny", "deny"]);
    expect(await userComputerGate(context({ card: true }).ctx, true, name, { ...args })).toBe(
      "deny",
    );
  });

  it("reminders asks a bot's first read and allows it once allowed, in every mode", async () => {
    const args = TOOLS[PHONE_REMINDERS_READ_TOOL].args;
    for (const mode of Object.keys(MODES) as Array<keyof typeof MODES>) {
      expect(await gate(context({ mode }).ctx, { ...args }, PHONE_REMINDERS_READ_TOOL)).toBe(
        "recorded",
      );
      expect(
        await gate(context({ mode, consent: true }).ctx, { ...args }, PHONE_REMINDERS_READ_TOOL),
      ).toBe("recorded");
    }
    expect(plans).toEqual(["ask", "allow", "ask", "allow", "ask", "allow"]);
  });
});
