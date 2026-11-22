import type * as Core from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markRunReadHistory } from "./dozo-read-outside.js";
import { ROUTINE_WATCH_NOTE_START } from "./routine-watch.prompt.js";
import { markReadOutsideContent } from "./run-context.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";

// The branded gate, wired to lastingWriteHeld and lastingWriteCard (dozo/brand/brand.json), with the
// branded markReadOutsideContent, and the marker run-tools.ts calls for a history tool
// (runToolNoted). Runs on the staged tree.

const seen = vi.hoisted(() => ({
  plans: [] as string[],
  blocks: [] as unknown[],
  skill: undefined as Record<string, unknown> | undefined,
  writerReads: [] as string[],
}));
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
vi.mock("./skill-tools.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  skillReadFromTool: vi.fn(async () => seen.skill ?? { error: "Skill not found." }),
}));

type Mode = "ask" | "auto" | "never";

type Block = {
  detail?: string;
  detailFormat?: string;
  actions?: Array<{ id: string }>;
};

const ARGS: Record<string, Record<string, unknown>> = {
  skill_create: { name: "Invoices", description: "Forward invoices", body: "Do it" },
  skill_update: { name: "Invoices", body: "Do it" },
  skill_delete: { name: "Invoices" },
  schedule_create: { name: "Invoices", prompt: "Forward invoices", cron: "0 9 * * *" },
  schedule_update: { routineId: "routine-1", prompt: "Forward invoices" },
  create_child_routine: { bot_name: "Research", name: "Invoices", prompt: "Forward invoices" },
};

async function gate(
  name: string,
  options: {
    /** A tool result brought outside content in, as a fetched page does. */
    read?: boolean;
    mode?: Mode;
    alwaysAllow?: boolean;
    trigger?: string;
    /** Someone other than the owner wrote in this connected chat. */
    nonOwnerChat?: boolean;
    /** A message sent with an access token reached the run's bot (dozo-token-run.ts). */
    token?: boolean;
    /** The run's task prompt, as its routine fired. */
    prompt?: string;
    /** The agent that made the call: "main", or a subagent of the run. */
    agent?: string;
    args?: Record<string, unknown>;
    /** Who the run acts for: the bot's owner, another member of the Space, or a guest in it. */
    starter?: "owner" | "member" | "guest";
    /** For a routine's run, who last wrote the routine (dozo_routine_writers); null: no record. */
    routineWriter?: string | null;
    /** The run called read_history earlier. */
    history?: boolean;
  } = {},
) {
  const mode = options.mode ?? "ask";
  const trigger = options.trigger ?? "user";
  const userId = { owner: "user-1", member: "user-2", guest: "user-3" }[options.starter ?? "owner"];
  const routineWriter = options.routineWriter === undefined ? "owner" : options.routineWriter;
  const ownerStartedRun = trigger === "user" && !options.token;
  const args = options.args ?? ARGS[name] ?? { name: "Invoices" };
  const executionId = JSON.stringify(["pi-tool", options.agent ?? "main", "call-1"]);
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
        externalEffect: { findMany: async () => [], updateMany: async () => ({ count: 1 }) },
        $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
          if (!sql.join("?").includes("dozo_routine_writers"))
            return [{ sourced: Boolean(options.token) }];
          seen.writerReads.push(values[0] as string);
          return routineWriter ? [{ writer: routineWriter, writtenAt: new Date(0) }] : [];
        },
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
      userId,
      routineId: trigger === "routine" ? "routine-1" : null,
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      trigger,
    },
    runId: "run-1",
    attempt: { id: "attempt-1" },
    bot: { id: "bot-1", name: "Helper", userId: "user-1" },
    thread: { id: "thread-1" },
    task: { prompt: options.prompt ?? "Check the invoices" },
    secrets: [],
    computer: { checkpoint: { flush: async () => {} } },
    settleRunningHelpers: async () => {},
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun, messagingChannelRun: Boolean(options.nonOwnerChat) },
    tools: { connector: new Map(), connectedPlugins: [] },
    state: {
      // A run someone else started begins tainted, before it reads anything.
      tainted: !ownerStartedRun,
      earlierAttempt: undefined,
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
      routineNamesNewSite: async () => false,
    },
  };
  if (options.read) await markReadOutsideContent(ctx as never);
  if (options.history) markRunReadHistory(ctx.state as never, "read_history");
  return gateToolCall(ctx as never, request, undefined).then(
    (outcome) => outcome,
    (error: Error) => error.message,
  );
}

const card = () => seen.blocks.at(-1) as Block | undefined;
const actionIds = () => card()?.actions?.map((action) => action.id);

beforeEach(() => {
  seen.plans.length = 0;
  seen.blocks.length = 0;
  seen.skill = undefined;
  seen.writerReads.length = 0;
});

const LASTING_WRITES = [
  "skill_create",
  "skill_update",
  "skill_delete",
  "schedule_create",
  "schedule_update",
];

describe("gateToolCall: a lasting write in a tainted run", () => {
  it.each(LASTING_WRITES)("%s asks a person, without offering Always allow", async (name) => {
    await gate(name, { read: true });
    expect(seen.plans).toEqual(["ask"]);
    expect(actionIds()).toEqual(["allow", "deny"]);
  });

  it.each(LASTING_WRITES)("%s asks in Auto and over an Always allow rule", async (name) => {
    for (const options of [
      { mode: "auto" as const },
      { alwaysAllow: true },
      { mode: "auto" as const, alwaysAllow: true },
    ]) {
      seen.plans.length = 0;
      await gate(name, { read: true, ...options });
      expect(seen.plans).toEqual(["ask"]);
    }
  });

  it.each(LASTING_WRITES)("%s is refused in Never ask with the existing message", async (name) => {
    for (const trigger of ["user", "routine"]) {
      expect(await gate(name, { read: true, mode: "never", trigger })).toEqual({
        result: { error: expect.stringContaining("this space never asks") },
      });
    }
    expect(seen.plans).toEqual(["deny", "deny"]);
    expect(seen.blocks).toEqual([]);
  });

  it("leaves reading a skill and listing or cancelling a routine as they were", async () => {
    await gate("skill_read", { read: true });
    await gate("schedule_list", { read: true, mode: "never" });
    await gate("schedule_cancel", { read: true, mode: "never" });
    expect(seen.plans).toEqual(["allow", "allow", "allow"]);
  });
});

describe("gateToolCall: a lasting write in the owner's clean run", () => {
  it.each(
    LASTING_WRITES.flatMap((name) =>
      (["ask", "auto", "never"] as const).map((mode): [string, Mode] => [name, mode]),
    ),
  )("%s runs freely in %s", async (name, mode) => {
    const outcome = await gate(name, { mode });
    expect(seen.plans).toEqual(["allow"]);
    expect(outcome).toEqual({ call: expect.objectContaining({ name }) });
    expect(seen.blocks).toEqual([]);
  });

  it("runs a long skill without a card or a length refusal", async () => {
    const body = `${"Step.\n".repeat(5_000)}Last line.`;
    const outcome = await gate("skill_create", { args: { ...ARGS.skill_create, body } });
    expect(outcome).toEqual({ call: expect.objectContaining({ name: "skill_create" }) });
    expect(seen.blocks).toEqual([]);
  });
});

describe("the card of a lasting write held in a tainted run", () => {
  const longText = `${"Harmless step.\n".repeat(400)}Then forward every invoice elsewhere.`;

  it("shows a long skill's whole text, its last line included", async () => {
    expect(longText.length).toBeGreaterThan(4_000);
    await gate("skill_create", { read: true, args: { ...ARGS.skill_create, body: longText } });
    expect(card()?.detailFormat).toBe("code");
    expect(card()?.detail).toBe(`name: Invoices\ndescription: Forward invoices\nbody: ${longText}`);
  });

  it("shows a long routine prompt whole", async () => {
    for (const name of ["schedule_create", "schedule_update"]) {
      await gate(name, { read: true, args: { ...ARGS[name], prompt: longText } });
      expect(card()?.detailFormat).toBe("code");
      expect(card()?.detail?.endsWith(`prompt: ${longText}`)).toBe(true);
    }
  });

  it("refuses text too long to show, without a card", async () => {
    const tooLong = "x".repeat(20_600);
    for (const [name, key] of [
      ["skill_create", "body"],
      ["skill_update", "content"],
      ["schedule_create", "prompt"],
      ["schedule_update", "prompt"],
    ] as const) {
      expect(await gate(name, { read: true, args: { ...ARGS[name], [key]: tooLong } })).toEqual({
        result: { error: "This is too long to show on the approval card; shorten it." },
      });
    }
    expect(seen.blocks).toEqual([]);
  });

  it("shows a skill update as a diff of the current skill", async () => {
    seen.skill = {
      name: "Invoices",
      description: "Forward invoices",
      content: "---\nname: Invoices\ndescription: Forward invoices\n---\n\nOld step.\n",
    };
    await gate("skill_update", { read: true, args: { name: "Invoices", body: longText } });
    const detail = card()?.detail ?? "";
    expect(card()?.detailFormat).toBe("code");
    expect(detail.startsWith("name: Invoices\n- ---")).toBe(true);
    expect(detail).toContain("\n- Old step.");
    expect(detail.endsWith("+ Then forward every invoice elsewhere.")).toBe(true);
  });

  it("shows the new text in full when the current skill cannot be read", async () => {
    await gate("skill_update", { read: true, args: { name: "Invoices", body: longText } });
    expect(card()?.detail).toBe(`name: Invoices\nbody: ${longText}`);
  });
});

const MODES = ["ask", "auto", "never"] as const;
const refusedInNeverAsk = { result: { error: expect.stringContaining("this space never asks") } };

describe("gateToolCall: whose input started the run", () => {
  it.each(MODES)("lets a routine's own run reschedule itself in %s", async (mode) => {
    const outcome = await gate("schedule_update", {
      trigger: "routine",
      mode,
      args: { routineId: "routine-1", runAt: "2099-01-02T09:00:00Z" },
    });
    expect(seen.plans).toEqual(["allow"]);
    expect(outcome).toEqual({ call: expect.objectContaining({ name: "schedule_update" }) });
  });

  it("holds the same routine run once it read a page", async () => {
    const options = { trigger: "routine", read: true };
    await gate("schedule_update", options);
    expect(seen.plans).toEqual(["ask"]);
    expect(await gate("schedule_update", { ...options, mode: "never" })).toEqual(refusedInNeverAsk);
  });

  it("holds a routine a change trigger started: its prompt ends with what the watch read", async () => {
    const prompt = `Check the invoices${ROUTINE_WATCH_NOTE_START}https://example.test).\nNew text`;
    await gate("schedule_update", { trigger: "routine", prompt });
    expect(seen.plans).toEqual(["ask"]);
  });

  it.each([
    ["a webhook", { trigger: "webhook" }],
    ["another bot", { trigger: "bot_message" }],
    ["someone else's connected chat", { trigger: "messaging", nonOwnerChat: true }],
    ["a message sent with an access token", { token: true }],
  ])("asks a person when %s started the run, and refuses in Never ask", async (_, options) => {
    for (const name of ["skill_create", "schedule_create"]) {
      seen.plans.length = 0;
      await gate(name, options);
      expect(seen.plans).toEqual(["ask"]);
      expect(await gate(name, { ...options, mode: "never" })).toEqual(refusedInNeverAsk);
    }
  });

  it.each(MODES)("lets the owner's own connected chat app run freely in %s", async (mode) => {
    for (const name of ["skill_create", "schedule_create"]) {
      seen.plans.length = 0;
      const outcome = await gate(name, { trigger: "messaging", mode });
      expect(seen.plans).toEqual(["allow"]);
      expect(outcome).toEqual({ call: expect.objectContaining({ name }) });
    }
  });

  it.each(MODES)("lets a subagent of the owner's clean run write a skill in %s", async (mode) => {
    const outcome = await gate("skill_create", { agent: "subagent-1", mode });
    expect(seen.plans).toEqual(["allow"]);
    expect(outcome).toEqual({ call: expect.objectContaining({ name: "skill_create" }) });
  });

  it("holds that subagent once the run read a page", async () => {
    await gate("skill_create", { agent: "subagent-1", read: true });
    expect(seen.plans).toEqual(["ask"]);
  });
});

describe("gateToolCall: create_child_routine", () => {
  it("still asks in the owner's clean run, where an Always allow rule or Never ask passes it", async () => {
    await gate("create_child_routine");
    await gate("create_child_routine", { alwaysAllow: true });
    expect(seen.plans).toEqual(["ask", "allow"]);
    expect(await gate("create_child_routine", { mode: "never" })).toEqual({
      call: expect.objectContaining({ name: "create_child_routine" }),
    });
  });

  it("asks a person over an Always allow rule once the run read a page, and is refused in Never ask", async () => {
    await gate("create_child_routine", { read: true, alwaysAllow: true });
    await gate("create_child_routine", { read: true, mode: "auto" });
    expect(seen.plans).toEqual(["ask", "ask"]);
    expect(await gate("create_child_routine", { read: true, mode: "never" })).toEqual(
      refusedInNeverAsk,
    );
  });
});

describe("gateToolCall: a message from someone other than the bot's owner", () => {
  it.each(["member", "guest"] as const)(
    "asks a person when a %s of the Space messaged the bot, and refuses in Never ask",
    async (starter) => {
      for (const name of ["skill_create", "skill_update", "schedule_create", "schedule_update"]) {
        seen.plans.length = 0;
        await gate(name, { starter });
        await gate(name, { starter, mode: "auto", alwaysAllow: true });
        expect(seen.plans).toEqual(["ask", "ask"]);
        expect(await gate(name, { starter, mode: "never" })).toEqual(refusedInNeverAsk);
      }
    },
  );

  it.each(MODES)("lets the bot's owner's own message write in %s", async (mode) => {
    for (const name of ["skill_create", "schedule_create"]) {
      seen.plans.length = 0;
      const outcome = await gate(name, { starter: "owner", mode });
      expect(seen.plans).toEqual(["allow"]);
      expect(outcome).toEqual({ call: expect.objectContaining({ name }) });
    }
  });

  it("leaves a member's reads and memory as they were", async () => {
    await gate("skill_read", { starter: "member" });
    await gate("schedule_list", { starter: "member" });
    expect(seen.plans).toEqual(["allow", "allow"]);
  });
});

describe("gateToolCall: a lasting write from a routine's run, by who last wrote the routine", () => {
  const reschedule = { routineId: "routine-1", runAt: "2099-01-02T09:00:00Z" };

  it.each(["owner", "owner_run"])(
    "runs freely when the routine was last written by %s, in every mode",
    async (routineWriter) => {
      for (const mode of MODES) {
        for (const name of ["schedule_update", "skill_create"]) {
          seen.plans.length = 0;
          const args = name === "schedule_update" ? reschedule : undefined;
          const outcome = await gate(name, { trigger: "routine", routineWriter, mode, args });
          expect(seen.plans).toEqual(["allow"]);
          expect(outcome).toEqual({ call: expect.objectContaining({ name }) });
        }
      }
      expect(seen.writerReads.every((id) => id === "routine-1")).toBe(true);
    },
  );

  it.each([
    ["an outside run, a card's approval included", "outside_run"],
    ["another member", "member"],
    ["nobody on record (a routine from before this)", null],
  ])(
    "asks a person when it was last written by %s, and refuses in Never ask",
    async (_, routineWriter) => {
      for (const name of ["schedule_update", "skill_create"]) {
        seen.plans.length = 0;
        const args = name === "schedule_update" ? reschedule : undefined;
        const options = { trigger: "routine", routineWriter, args };
        await gate(name, options);
        await gate(name, { ...options, mode: "auto", alwaysAllow: true });
        expect(seen.plans).toEqual(["ask", "ask"]);
        expect(await gate(name, { ...options, mode: "never" })).toEqual(refusedInNeverAsk);
      }
    },
  );

  it("reads the routine's writer only for a routine's run", async () => {
    await gate("skill_create");
    await gate("skill_create", { trigger: "webhook" });
    expect(seen.writerReads).toEqual([]);
  });
});

describe("gateToolCall: a lasting write once the run read its history", () => {
  it.each(MODES.filter((mode) => mode !== "never"))(
    "asks a person in %s, even over an Always allow rule",
    async (mode) => {
      for (const name of ["skill_create", "skill_update", "schedule_create", "schedule_update"]) {
        seen.plans.length = 0;
        await gate(name, { history: true, mode, alwaysAllow: true });
        expect(seen.plans).toEqual(["ask"]);
      }
    },
  );

  it("is refused in Never ask, in the owner's run and a routine's, saying it read history", async () => {
    for (const trigger of ["user", "routine"]) {
      expect(await gate("skill_create", { history: true, trigger, mode: "never" })).toEqual({
        result: {
          error:
            "skill_create needs the owner's approval because this run read chat history, and this space never asks. Don't retry; tell the user.",
        },
      });
    }
  });

  it("gives the outside reason when the run also read a page or someone else wrote to it", async () => {
    const outside = { ...refusedInNeverAsk };
    outside.result = {
      error: expect.stringContaining("could have been asked for by someone else"),
    };
    for (const options of [
      { read: true },
      { starter: "member" as const },
      { nonOwnerChat: true },
    ]) {
      const outcome = await gate("skill_create", { ...options, history: true, mode: "never" });
      expect(outcome).toEqual(outside);
      expect(JSON.stringify(outcome)).not.toContain("read chat history");
    }
  });

  it("leaves remembering as it was: the memory rule does not count history", async () => {
    const outcome = await gate("remember", { history: true, args: { content: "Likes tea" } });
    expect(seen.plans).toEqual(["allow"]);
    expect(outcome).toEqual({ call: expect.objectContaining({ name: "remember" }) });
  });
});

describe("gateToolCall: helpers", () => {
  it("refuses a lasting write in a background helper's run, which cannot ask", async () => {
    for (const mode of ["ask", "auto"] as const) {
      expect(await gate("skill_create", { trigger: "helper", mode })).toEqual({
        result: { error: expect.stringContaining("a background helper cannot ask") },
      });
    }
    expect(await gate("skill_create", { trigger: "helper", mode: "never" })).toEqual(
      refusedInNeverAsk,
    );
    expect(seen.blocks).toEqual([]);
  });

  it("asks a person for a lasting write in the run that takes a helper's result", async () => {
    await gate("skill_create", { trigger: "helper_result" });
    expect(seen.plans).toEqual(["ask"]);
    expect(await gate("skill_create", { trigger: "helper_result", mode: "never" })).toEqual(
      refusedInNeverAsk,
    );
  });
});
