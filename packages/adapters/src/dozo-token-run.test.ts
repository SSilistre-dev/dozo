import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  DOZO_TOKEN_CARD_LASTING,
  DOZO_TOKEN_CARD_REASON,
  dozoBotTokenTainted,
  dozoTokenRunAsk,
  dozoTokenRunMade,
  dozoTokenRunPlan,
  reachedBots,
  runCameByToken,
} from "./dozo-token-run.js";
import type { RunContext } from "./run-context.js";

const sqlOf = (call: unknown[]) => (call[0] as string[]).join("?");

/**
 * A run whose bot is marked or not. Lookups answer from `bots` (id or lower-case name to ids) and
 * `groups` (id or lower-case name to member ids); anything else answers whether the run is marked.
 */
function context(
  sourced: boolean,
  world: { bots?: Record<string, string[]>; groups?: Record<string, (string | null)[]> } = {},
) {
  const queryRaw = vi.fn(async (...call: unknown[]) => {
    const sql = sqlOf(call);
    const value = String(call[1]).toLowerCase();
    if (sql.includes("FROM chat_groups"))
      return (world.groups?.[value] ?? []).map((id) => ({ id }));
    if (sql.includes("SELECT id FROM bots"))
      return (world.bots?.[value] ?? []).map((id) => ({ id }));
    return [{ sourced }];
  });
  const executeRaw = vi.fn(async (..._call: unknown[]) => 1);
  const ctx = {
    run: { id: "run-1", botId: "bot-1", threadId: "thread-1", spaceId: "space-1" },
    deps: { prisma: { $queryRaw: queryRaw, $executeRaw: executeRaw } },
  } as unknown as RunContext;
  const marks = () =>
    executeRaw.mock.calls
      .filter((call) => sqlOf(call).includes("INSERT INTO dozo_token_taints"))
      .map((call) => call.slice(1));
  return { ctx, queryRaw, executeRaw, marks };
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

describe("dozoBotTokenTainted", () => {
  it("looks at the run's chat, the bot and its parents' chats, and marks not cleared or lasting", async () => {
    const { ctx, queryRaw } = context(true);
    expect(await dozoBotTokenTainted(ctx.deps.prisma, ctx.run)).toBe(true);
    const [first, ...values] = queryRaw.mock.calls[0]!;
    const text = sqlOf([first]);
    expect(text).toContain("WITH RECURSIVE lineage");
    expect(text).toContain('b."parentBotId"');
    expect(text).toContain(`"clientNonce" LIKE 'api:%'`);
    expect(text).toContain("x.lasting OR NOT EXISTS");
    expect(text).toContain(`e."createdAt" AT TIME ZONE 'UTC' > x."createdAt"`);
    expect(values).toEqual(["bot-1", "thread-1"]);
    queryRaw.mockResolvedValueOnce([]);
    expect(await dozoBotTokenTainted(ctx.deps.prisma, ctx.run)).toBe(false);
  });
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
    expect(
      await dozoTokenRunPlan(
        context(true).ctx,
        call("demo_send", { viaConnector: true, consequential: true }),
        "judge",
      ),
    ).toBe("ask");
    expect(
      await dozoTokenRunPlan(
        context(true).ctx,
        call("user_computer_shell", { consequential: true }),
        "allow",
      ),
    ).toBe("ask");
  });

  it("lets reads through, upstream's read-only builtins too, keeps a refusal, and leaves runs no token reached alone", async () => {
    const token = context(true);
    for (const name of ["read_file", "board_tickets", "ticket_get"])
      expect(await dozoTokenRunPlan(token.ctx, call(name), "allow")).toBe("allow");
    expect(
      await dozoTokenRunPlan(token.ctx, call("demo_get", { viaConnector: true }), "allow"),
    ).toBe("allow");
    expect(await dozoTokenRunPlan(token.ctx, call("shell"), "deny")).toBe("deny");
    expect(token.queryRaw).not.toHaveBeenCalled();
    expect(await dozoTokenRunPlan(context(false).ctx, call("shell"), "allow")).toBe("allow");
  });

  it("marks every bot a reaching call names, by id or by name, before asking", async () => {
    const world = {
      bots: { "bot-2": ["bot-2"], research: ["bot-3", "bot-4"], scout: ["bot-5"] },
      groups: { "group-1": ["bot-6", null], team: ["bot-7"] },
    };
    const cases: [string, Record<string, unknown>, string[]][] = [
      ["message_bot", { bot_id: "bot-2" }, ["bot-2"]],
      ["message_bot", { confirm_name: "Research" }, ["bot-3", "bot-4"]],
      [
        "handoff_to_bot",
        { confirm_name: " research ", group_id: "group-1" },
        ["bot-3", "bot-4", "bot-6"],
      ],
      ["create_child_routine", { bot_name: "Scout" }, ["bot-5"]],
      ["set_child_instructions", { bot_name: "scout" }, ["bot-5"]],
      ["create_group", { bot_names: ["Scout"], bot_ids: ["bot-2"] }, ["bot-2", "bot-5"]],
      ["update_group", { group_name: "Team", add_bot_ids: ["bot-2"] }, ["bot-2", "bot-7"]],
      ["ticket_create", { ownerBotId: "bot-2" }, ["bot-2"]],
      ["update_bot", { bot_id: "bot-2" }, ["bot-2"]],
    ];
    for (const [name, args, bots] of cases) {
      const token = context(true, world);
      expect(await dozoTokenRunPlan(token.ctx, call(name, { args }), "allow")).toBe("ask");
      expect(token.marks().map(([space, bot, run]) => [space, run, bot])).toEqual(
        bots.sort().map((bot) => ["space-1", "run-1", bot]),
      );
    }
  });

  it("refuses a reaching call whose bot or group it cannot find, and marks nothing", async () => {
    for (const args of [{ confirm_name: "Nobody" }, { bot_id: "bot-9" }, { group_name: "None" }]) {
      const token = context(true);
      expect(await dozoTokenRunPlan(token.ctx, call("message_bot", { args }), "allow")).toBe(
        "deny",
      );
      expect(token.marks()).toEqual([]);
    }
  });

  it("marks nothing for the run's own bot, a run no token reached, or a call with no target", async () => {
    const self = context(true, { bots: { "bot-1": ["bot-1"] } });
    await dozoTokenRunPlan(self.ctx, call("update_bot", { args: { bot_id: "bot-1" } }), "allow");
    const own = context(true);
    await dozoTokenRunPlan(own.ctx, call("update_bot"), "allow");
    const clean = context(false, { bots: { "bot-2": ["bot-2"] } });
    await dozoTokenRunPlan(clean.ctx, call("message_bot", { args: { bot_id: "bot-2" } }), "allow");
    expect([...self.marks(), ...own.marks(), ...clean.marks()]).toEqual([]);
  });
});

describe("reachedBots", () => {
  it("looks only in the run's Space, and ignores what is not a name or id", async () => {
    const token = context(true, { bots: { "bot-2": ["bot-2"] } });
    expect(await reachedBots(token.ctx, { bot_id: "bot-2", bot_names: [3, null] })).toEqual([
      "bot-2",
    ]);
    expect(token.queryRaw.mock.calls[0]).toContain("space-1");
  });
});

describe("dozoTokenRunMade", () => {
  it("marks a bot a marked run spawned, and the bot of a routine it made or changed, for good", async () => {
    const spawned = context(true);
    await dozoTokenRunMade(spawned.ctx, "spawn_bot", {}, { ok: true, botId: "bot-8" });
    const [spawnSql, ...spawnValues] = spawned.executeRaw.mock.calls[0]!;
    expect(sqlOf([spawnSql])).toContain("lasting");
    expect(spawnValues).toEqual(["space-1", "run-1", "bot-8", "space-1"]);
    for (const [name, args, result] of [
      ["schedule_create", {}, { routineId: "routine-1" }],
      ["create_child_routine", {}, { routineId: "routine-1", botId: "bot-2" }],
      ["schedule_update", { routineId: "routine-1" }, { ok: true }],
    ] as const) {
      const token = context(true);
      await dozoTokenRunMade(token.ctx, name, args, result);
      const [sql, ...values] = token.executeRaw.mock.calls[0]!;
      expect(sqlOf([sql])).toContain("FROM routines r");
      expect(values).toEqual(["space-1", "run-1", "routine-1", "space-1"]);
    }
  });

  it("marks nothing for another call, a run no token reached, or a result without an id", async () => {
    const calls = [
      [context(true), "shell", {}, { botId: "bot-8" }],
      [context(false), "spawn_bot", {}, { botId: "bot-8" }],
      [context(true), "spawn_bot", {}, { error: "Name taken" }],
      [context(true), "schedule_create", {}, null],
    ] as const;
    for (const [token, name, args, result] of calls) {
      await dozoTokenRunMade(token.ctx, name, args, result);
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
