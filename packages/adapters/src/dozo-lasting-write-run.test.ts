import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApprovedEffectReplayQueue } from "./approval-effect.js";
import { runReadHistory } from "./dozo-read-outside.js";
import { markReadOutsideContent } from "./run-context.js";
import { applyTool } from "./run-tools.js";

// The branded applyTool, which runs every call the gate let through with runToolNoted
// (dozo/brand/brand.json). The gate has its own tests (dozo-lasting-write-gate.test.ts); here it
// lets every call through, as after a person's approval. Runs on the staged tree.

const seen = vi.hoisted(() => ({
  records: [] as Array<{ routineId: string; spaceId: string; writer: string; at: string }>,
  order: [] as string[],
  result: undefined as unknown,
  recordFails: false,
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordRoutineWriter: vi.fn(
    async (_db: unknown, routine: { routineId: string; spaceId: string }, writer: string) => {
      if (seen.recordFails) throw new Error("database unavailable");
      seen.records.push({ ...routine, writer, at: `after ${seen.order.length} writes` });
    },
  ),
}));
vi.mock("./run-tool-gate.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  gateToolCall: vi.fn(async (_ctx: unknown, request: { name: string; args: unknown }) => ({
    call: {
      name: request.name,
      args: request.args,
      executionId: "call-1",
      connectorCall: { tool: request.name, args: request.args, executionId: "call-1" },
      applied: undefined,
      finish: async (result: unknown) => result,
    },
  })),
}));
vi.mock("./run-tool-request.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveToolRequest: vi.fn(async (_ctx: unknown, name: string, args: unknown) => ({
    name,
    args,
    catalogRemapped: false,
  })),
  prepareToolRequest: vi.fn(async () => undefined),
}));
const write = (name: string) => async () => {
  seen.order.push(name);
  return seen.result ?? { ok: true, routineId: "routine-9" };
};
vi.mock("./schedule-tools.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createScheduleFromTool: vi.fn(async () => write("schedule_create")()),
  updateScheduleFromTool: vi.fn(async () => write("schedule_update")()),
}));
vi.mock("./fleet-tools.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createChildRoutine: vi.fn(async () => write("create_child_routine")()),
}));
vi.mock("./run-tools-memory.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  memoryTools: {
    read_history: async () => ({ messages: [] }),
    search_history: async () => {
      throw new Error("search failed");
    },
  },
}));

function context(options: { starter?: "owner" | "member"; trigger?: string } = {}) {
  const trigger = options.trigger ?? "user";
  return {
    deps: {
      prisma: {
        attempt: { count: async () => 1 },
        $queryRaw: async (sql: TemplateStringsArray) =>
          sql.join("?").includes("dozo_routine_writers")
            ? [{ writer: "owner", writtenAt: new Date(0) }]
            : [{ sourced: false }],
      },
    },
    run: {
      id: "run-1",
      spaceId: "space-1",
      userId: options.starter === "member" ? "user-2" : "user-1",
      trigger,
      routineId: trigger === "routine" ? "routine-1" : null,
      clientNonce: null,
    },
    runId: "run-1",
    bot: { id: "bot-1", userId: "user-1" },
    thread: { id: "thread-1", groupId: null },
    task: { prompt: "Check the invoices" },
    source: { ownerStartedRun: trigger === "user", messagingChannelRun: false },
    state: { tainted: false, earlierAttempt: undefined, handedOff: false },
    trust: { receivedOutsideMessage: async () => false },
    tools: {
      offered: [{ name: "read_history" }, { name: "search_history" }],
      disabled: new Set<string>(),
      approvedReplays: createApprovedEffectReplayQueue([]),
      connector: new Map(),
    },
    computer: { pageBrowserAllowed: true, acceptsImages: true },
    context: { signal: new AbortController().signal },
    fleetRun: {},
    secrets: [],
  };
}

const ROUTINE_WRITES: Array<[string, Record<string, unknown>]> = [
  ["schedule_create", { name: "Invoices", prompt: "Forward invoices", cron: "0 9 * * *" }],
  ["schedule_update", { routineId: "routine-9", prompt: "Forward invoices" }],
  ["create_child_routine", { bot_name: "Research", name: "Invoices", prompt: "Forward invoices" }],
];

beforeEach(() => {
  seen.records.length = 0;
  seen.order.length = 0;
  seen.result = undefined;
  seen.recordFails = false;
});

describe("runToolNoted: who wrote a routine", () => {
  it.each(ROUTINE_WRITES)("records the owner's clean run writing with %s", async (name, args) => {
    await applyTool(context() as never, name, args, "call-1");
    expect(seen.records).toEqual([
      { routineId: "routine-9", spaceId: "space-1", writer: "owner_run", at: "after 1 writes" },
    ]);
  });

  it.each(ROUTINE_WRITES)(
    "records %s in a run that read outside content as an outside run's, approved or not",
    async (name, args) => {
      const ctx = context();
      await markReadOutsideContent(ctx as never);
      await applyTool(ctx as never, name, args, "call-1");
      const outside = { routineId: "routine-9", spaceId: "space-1", writer: "outside_run" };
      expect(seen.records.at(-1)).toEqual({ ...outside, at: "after 1 writes" });
      // A change to an existing routine is recorded before it is written, too.
      if (name === "schedule_update")
        expect(seen.records[0]).toEqual({ ...outside, at: "after 0 writes" });
    },
  );

  it.each(ROUTINE_WRITES)(
    "records %s in a run another member started as an outside run's",
    async (name, args) => {
      await applyTool(context({ starter: "member" }) as never, name, args, "call-1");
      expect(seen.records.at(-1)?.writer).toBe("outside_run");
    },
  );

  it("records an outside run's routine even when its own run started it", async () => {
    // A routine's run is free only while the owner last wrote it, which the next write reads.
    const ctx = context({ trigger: "routine" });
    await markReadOutsideContent(ctx as never);
    await applyTool(ctx as never, "schedule_create", ROUTINE_WRITES[0]![1], "call-1");
    expect(seen.records.at(-1)?.writer).toBe("outside_run");
  });

  it("keeps the record when the owner's clean run only pauses or moves a routine", async () => {
    const ctx = context({ trigger: "routine" });
    await applyTool(
      ctx as never,
      "schedule_update",
      { routineId: "routine-9", active: false },
      "call-1",
    );
    await applyTool(
      ctx as never,
      "schedule_update",
      { routineId: "routine-9", prompt: " " },
      "call-1",
    );
    expect(seen.order).toEqual(["schedule_update", "schedule_update"]);
    expect(seen.records).toEqual([]);
  });

  it("records nothing for a write that failed", async () => {
    seen.result = { error: "Schedule not found." };
    for (const [name, args] of ROUTINE_WRITES)
      await applyTool(context() as never, name, args, "call-1");
    expect(seen.records).toEqual([]);
  });
});

describe("runToolNoted: a record that cannot be saved", () => {
  it("stops a held change before it is written", async () => {
    const ctx = context({ starter: "member" });
    seen.recordFails = true;
    await expect(
      applyTool(ctx as never, "schedule_update", ROUTINE_WRITES[1]![1], "call-1"),
    ).rejects.toThrow("database unavailable");
    expect(seen.order).toEqual([]);
  });

  it("does not fail a write that was saved", async () => {
    seen.recordFails = true;
    for (const [name, args] of ROUTINE_WRITES) {
      expect(await applyTool(context() as never, name, args, "call-1")).toEqual({
        ok: true,
        routineId: "routine-9",
      });
    }
    expect(seen.order).toEqual(ROUTINE_WRITES.map(([name]) => name));
  });
});

describe("runToolNoted: history", () => {
  it("notes a history tool the run called, one that failed included", async () => {
    const ctx = context();
    await applyTool(ctx as never, "schedule_list", {}, "call-1").catch(() => undefined);
    expect(runReadHistory(ctx.state as never)).toBe(false);
    await applyTool(ctx as never, "read_history", { before: 10 }, "call-1");
    expect(runReadHistory(ctx.state as never)).toBe(true);
    const other = context();
    await expect(
      applyTool(other as never, "search_history", { query: "invoices" }, "call-1"),
    ).rejects.toThrow("search failed");
    expect(runReadHistory(other.state as never)).toBe(true);
  });
});
