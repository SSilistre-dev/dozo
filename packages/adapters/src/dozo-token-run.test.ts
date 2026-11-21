import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  DOZO_TOKEN_CARD_REASON,
  dozoBotTokenTainted,
  dozoTokenRunAsk,
  dozoTokenRunPlan,
  runCameByToken,
} from "./dozo-token-run.js";
import type { RunContext } from "./run-context.js";

function context(sourced: boolean) {
  const queryRaw = vi.fn(async (..._args: unknown[]) => [{ sourced }]);
  const executeRaw = vi.fn(async (..._args: unknown[]) => 1);
  const ctx = {
    run: { id: "run-1", botId: "bot-1", threadId: "thread-1", spaceId: "space-1" },
    deps: { prisma: { $queryRaw: queryRaw, $executeRaw: executeRaw } },
  } as unknown as RunContext;
  return { ctx, queryRaw, executeRaw };
}

const sql = (call: unknown[]) => (call[0] as string[]).join("?");

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
  it("looks at the run's chat, the bot and its parents' chats, and marks not yet cleared", async () => {
    const { ctx, queryRaw } = context(true);
    expect(await dozoBotTokenTainted(ctx.deps.prisma, ctx.run)).toBe(true);
    const [first, ...values] = queryRaw.mock.calls[0]!;
    const text = sql([first]);
    expect(text).toContain("WITH RECURSIVE lineage");
    expect(text).toContain('b."parentBotId"');
    expect(text).toContain(`"clientNonce" LIKE 'api:%'`);
    expect(text).toContain("dozo_token_taints");
    expect(text).toContain("'thread.cleared'");
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
      "update_bot",
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

  it("lets reads through, keeps a refusal, and leaves runs no token reached alone", async () => {
    const token = context(true);
    expect(await dozoTokenRunPlan(token.ctx, call("read_file"), "allow")).toBe("allow");
    expect(
      await dozoTokenRunPlan(token.ctx, call("demo_get", { viaConnector: true }), "allow"),
    ).toBe("allow");
    expect(await dozoTokenRunPlan(token.ctx, call("shell"), "deny")).toBe("deny");
    expect(token.queryRaw).not.toHaveBeenCalled();
    expect(await dozoTokenRunPlan(context(false).ctx, call("shell"), "allow")).toBe("allow");
  });

  it("marks the bot a delegating call names, in the run's Space only", async () => {
    for (const name of ["message_bot", "handoff_to_bot", "create_child_routine"]) {
      const token = context(true);
      expect(
        await dozoTokenRunPlan(token.ctx, call(name, { args: { bot_id: "bot-2" } }), "ask"),
      ).toBe("ask");
      const [first, ...values] = token.executeRaw.mock.calls[0]!;
      expect(sql([first])).toContain("INSERT INTO dozo_token_taints");
      expect(sql([first])).toContain('b."spaceId" = ?');
      expect(values).toEqual(["space-1", "run-1", "bot-2", "space-1"]);
    }
    const unnamed = context(true);
    await dozoTokenRunPlan(unnamed.ctx, call("message_bot", { args: { name: "B" } }), "allow");
    const clean = context(false);
    await dozoTokenRunPlan(clean.ctx, call("message_bot", { args: { bot_id: "bot-2" } }), "allow");
    expect(unnamed.executeRaw).not.toHaveBeenCalled();
    expect(clean.executeRaw).not.toHaveBeenCalled();
  });
});

describe("dozoTokenRunAsk", () => {
  it("drops Always allow and says why on the card in a run a token reached", async () => {
    const block = await dozoTokenRunAsk(context(true).ctx, card);
    expect(block.kind === "ask" && block.actions?.map((action) => action.id)).toEqual([
      "allow",
      "deny",
    ]);
    expect(block.kind === "ask" && block.detail).toBe(
      `${DOZO_TOKEN_CARD_REASON}\n\nTo: someone@example.test`,
    );
    const bare = { kind: "ask", text: "Go?", status: "pending" } as MessageBlock;
    expect(await dozoTokenRunAsk(context(true).ctx, bare)).toEqual({
      ...bare,
      detail: DOZO_TOKEN_CARD_REASON,
    });
  });

  it("leaves other cards and runs alone", async () => {
    expect(await dozoTokenRunAsk(context(false).ctx, card)).toBe(card);
    const token = context(true);
    const text = { kind: "text", text: "hi" } as MessageBlock;
    expect(await dozoTokenRunAsk(token.ctx, text)).toBe(text);
    expect(token.queryRaw).not.toHaveBeenCalled();
  });
});
