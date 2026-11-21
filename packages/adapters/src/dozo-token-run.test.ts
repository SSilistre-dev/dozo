import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  DOZO_TOKEN_CARD_LASTING,
  DOZO_TOKEN_CARD_REASON,
  dozoTokenRunAsk,
  dozoTokenRunDone,
  dozoTokenRunPlan,
  runCameByToken,
} from "./dozo-token-run.js";
import type { RunContext } from "./run-context.js";

// What the SQL finds is covered against a real database in dozo-token-run.postgres.test.ts; these
// cover the decisions around it.

const sqlOf = (call: unknown[]) => (call[0] as string[]).join("?");

function context(sourced: boolean) {
  const queryRaw = vi.fn(async (..._call: unknown[]) => [{ sourced }]);
  const executeRaw = vi.fn(async (..._call: unknown[]) => 1);
  const ctx = {
    run: { id: "run-1", botId: "bot-1", threadId: "thread-1", spaceId: "space-1" },
    deps: { prisma: { $queryRaw: queryRaw, $executeRaw: executeRaw } },
  } as unknown as RunContext;
  const writes = () => executeRaw.mock.calls.map((call) => [sqlOf(call), ...call.slice(1)]);
  return { ctx, queryRaw, executeRaw, writes };
}

const card: MessageBlock = {
  kind: "ask",
  text: "Send this email?",
  detail: "To: someone@example.test",
  approvalEffectId: "effect-1",
  status: "pending",
  actions: [
    { id: "allow", label: "Allow once" },
    { id: "always", label: "Always allow this tool" },
    { id: "deny", label: "Deny" },
  ],
} as MessageBlock;

const call = (name: string, extra: Partial<Parameters<typeof dozoTokenRunPlan>[1]> = {}) => ({
  name,
  args: {},
  viaConnector: false,
  consequential: false,
  ...extra,
});

describe("runCameByToken", () => {
  it("keeps a yes for the rest of the run, and asks again after a no", async () => {
    const yes = context(true);
    expect(await runCameByToken(yes.ctx)).toBe(true);
    expect(await runCameByToken(yes.ctx)).toBe(true);
    expect(yes.queryRaw).toHaveBeenCalledOnce();
    const no = context(false);
    expect(await runCameByToken(no.ctx)).toBe(false);
    expect(await runCameByToken(no.ctx)).toBe(false);
    expect(no.queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("dozoTokenRunPlan", () => {
  it("asks before every call that is not a plain read, whatever the mode allowed", async () => {
    for (const name of [
      "shell",
      "write_file",
      "remember",
      "browser_act",
      "spawn_bot",
      "list_secrets",
    ])
      expect(await dozoTokenRunPlan(context(true).ctx, call(name), "allow")).toBe("ask");
    const send = call("demo_send", { viaConnector: true, consequential: true });
    expect(await dozoTokenRunPlan(context(true).ctx, send, "judge")).toBe("ask");
    const own = call("user_computer_shell", { consequential: true });
    expect(await dozoTokenRunPlan(context(true).ctx, own, "allow")).toBe("ask");
  });

  it("lets reads through, upstream's read-only builtins too, keeps a refusal, and leaves runs no token reached alone", async () => {
    const token = context(true);
    for (const name of ["read_file", "board_tickets", "ticket_get"])
      expect(await dozoTokenRunPlan(token.ctx, call(name), "allow")).toBe("allow");
    const read = call("demo_get", { viaConnector: true });
    expect(await dozoTokenRunPlan(token.ctx, read, "allow")).toBe("allow");
    expect(await dozoTokenRunPlan(token.ctx, call("shell"), "deny")).toBe("deny");
    expect(token.queryRaw).not.toHaveBeenCalled();
    expect(await dozoTokenRunPlan(context(false).ctx, call("shell"), "allow")).toBe("allow");
  });

  it("only asks: it marks nothing, whatever bot a call names", async () => {
    const token = context(true);
    const named = call("message_bot", { args: { confirm_name: "Research", message: "Hi" } });
    expect(await dozoTokenRunPlan(token.ctx, named, "allow")).toBe("ask");
    expect(token.executeRaw).not.toHaveBeenCalled();
  });

  it("refuses a call naming another bot by anything but a string, under any name its handler reads", async () => {
    const odd: [string, Record<string, unknown>][] = [
      ["message_bot", { bot_id: ["bot-2"] }],
      ["handoff_to_bot", { confirm_name: 7 }],
      ["archive_bot", { botId: { id: "bot-2" } }],
      ["archive_bot", { confirmName: null }],
      ["create_group", { bot_names: ["Scout", 3] }],
      ["update_group", { add_bot_ids: "bot-2" }],
      ["ticket_create", { ownerBotId: 2 }],
    ];
    for (const [name, args] of odd)
      expect(await dozoTokenRunPlan(context(true).ctx, call(name, { args }), "allow")).toBe("deny");
    const lists = call("create_group", { args: { bot_ids: ["bot-2"], bot_names: ["Scout"] } });
    expect(await dozoTokenRunPlan(context(true).ctx, lists, "allow")).toBe("ask");
    // A connector tool's own arguments are its own.
    const connector = call("message_bot", {
      viaConnector: true,
      consequential: true,
      args: { bot_id: 1 },
    });
    expect(await dozoTokenRunPlan(context(true).ctx, connector, "allow")).toBe("ask");
  });
});

describe("dozoTokenRunDone", () => {
  it("marks the bot whose instructions or ticket a marked run wrote, once it succeeded", async () => {
    const cases: [string, Record<string, unknown>, unknown][] = [
      ["set_child_instructions", {}, { ok: true, botId: "bot-2" }],
      ["update_bot", { bot_id: "bot-2" }, { ok: true }],
      ["ticket_create", {}, { ticket: { assigneeBotId: "bot-2" } }],
      ["ticket_update", {}, { ticket: { assigneeBotId: "bot-2" } }],
    ];
    for (const [name, args, result] of cases) {
      const token = context(true);
      await dozoTokenRunDone(token.ctx, name, args, result);
      const [[sql, ...values]] = token.writes() as [[string, ...unknown[]]];
      expect(sql).toContain("ON CONFLICT");
      expect(values).toEqual(["space-1", "run-1", "bot-2", "space-1"]);
    }
  });

  it("marks for good a bot a marked run spawned, and a routine it made or changed", async () => {
    const spawned = context(true);
    await dozoTokenRunDone(spawned.ctx, "spawn_bot", {}, { ok: true, botId: "bot-8" });
    const [[spawnSql, ...spawnValues]] = spawned.writes() as [[string, ...unknown[]]];
    expect(spawnSql).toContain("lasting");
    expect(spawnValues).toEqual(["space-1", "run-1", "bot-8", "space-1"]);
    for (const name of ["schedule_create", "schedule_update", "create_child_routine"]) {
      const token = context(true);
      await dozoTokenRunDone(token.ctx, name, {}, { ok: true, routineId: "routine-1" });
      const [[sql, ...values]] = token.writes() as [[string, ...unknown[]]];
      expect(sql).toContain("FROM routines r");
      expect(values).toEqual(["space-1", "run-1", "routine-1", "space-1"]);
    }
  });

  it("marks nothing for a failure, another call, the run's own bot, or a run no token reached", async () => {
    const cases: [ReturnType<typeof context>, string, Record<string, unknown>, unknown][] = [
      [
        context(true),
        "schedule_update",
        { routineId: "routine-1" },
        { error: "Schedule not found." },
      ],
      [context(true), "spawn_bot", {}, { error: "Name taken" }],
      [context(true), "spawn_bot", {}, { ok: true }],
      [context(true), "schedule_create", {}, { ok: true }],
      [context(true), "shell", {}, { ok: true }],
      [context(true), "update_bot", {}, { ok: true }],
      [context(true), "update_bot", { bot_id: "bot-1" }, { ok: true }],
      [context(true), "ticket_create", {}, { ticket: { assigneeBotId: null } }],
      [context(true), "spawn_bot", {}, null],
      [context(true), "spawn_bot", {}, ["bot-8"]],
      [context(false), "spawn_bot", {}, { ok: true, botId: "bot-8" }],
    ];
    for (const [token, name, args, result] of cases) {
      await dozoTokenRunDone(token.ctx, name, args, result);
      expect(token.executeRaw).not.toHaveBeenCalled();
    }
  });
});

describe("dozoTokenRunAsk", () => {
  it("drops Always allow and says why on the card in a run a token reached", async () => {
    const block = await dozoTokenRunAsk(context(true).ctx, "message_bot", card);
    expect(block.kind === "ask" && block.actions?.map((action) => action.id)).toEqual([
      "allow",
      "deny",
    ]);
    expect(block.kind === "ask" && block.detail).toBe(
      `${DOZO_TOKEN_CARD_REASON}\n\nTo: someone@example.test`,
    );
    const bare = { kind: "ask", text: "Go?", status: "pending" } as MessageBlock;
    expect(await dozoTokenRunAsk(context(true).ctx, "shell", bare)).toEqual({
      ...bare,
      detail: DOZO_TOKEN_CARD_REASON,
    });
  });

  it("says the mark lasts on a card for work that outlives the run", async () => {
    const block = await dozoTokenRunAsk(context(true).ctx, "spawn_bot", card);
    expect(block.kind === "ask" && block.detail).toBe(
      `${DOZO_TOKEN_CARD_REASON}\n${DOZO_TOKEN_CARD_LASTING}\n\nTo: someone@example.test`,
    );
  });

  it("leaves other cards and runs alone", async () => {
    expect(await dozoTokenRunAsk(context(false).ctx, "shell", card)).toBe(card);
    const token = context(true);
    const text = { kind: "text", text: "hi" } as MessageBlock;
    expect(await dozoTokenRunAsk(token.ctx, "shell", text)).toBe(text);
    expect(token.queryRaw).not.toHaveBeenCalled();
  });
});
