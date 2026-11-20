import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { dozoTokenRunAsk, dozoTokenRunPlan, runCameByToken } from "./dozo-token-run.js";
import type { RunContext } from "./run-context.js";

function context(sourced: boolean) {
  const queryRaw = vi.fn(async (..._args: unknown[]) => [{ sourced }]);
  const ctx = {
    runId: "run-1",
    deps: { prisma: { $queryRaw: queryRaw } },
  } as unknown as RunContext;
  return { ctx, queryRaw };
}

const card: MessageBlock = {
  kind: "ask",
  text: "Send this email?",
  approvalEffectId: "effect-1",
  status: "pending",
  actions: [
    { id: "allow", label: "Allow once" },
    { id: "always", label: "Always allow this tool" },
    { id: "deny", label: "Deny" },
  ],
} as MessageBlock;

describe("runCameByToken", () => {
  it("looks for a token's message as the source, an answer or a steer, by the run", async () => {
    const { ctx, queryRaw } = context(true);
    expect(await runCameByToken(ctx)).toBe(true);
    const [strings, ...values] = queryRaw.mock.calls[0]!;
    const sql = (strings as string[]).join("?");
    expect(sql).toContain('r."sourceMessageId"');
    expect(sql).toContain("steering_messages");
    expect(sql).toContain('s."claimedAt" IS NOT NULL');
    expect(values).toContain("run-1");
    expect(values).toContain("api:");
    // A yes is kept for the rest of the run.
    expect(await runCameByToken(ctx)).toBe(true);
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it("asks again after a no, since a token's message can still arrive", async () => {
    const { ctx, queryRaw } = context(false);
    expect(await runCameByToken(ctx)).toBe(false);
    queryRaw.mockResolvedValueOnce([]);
    expect(await runCameByToken(ctx)).toBe(false);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("dozoTokenRunPlan", () => {
  it("asks before an outside effect in a run a token reached, whatever the mode allowed", async () => {
    for (const plan of ["allow", "judge"] as const)
      expect(await dozoTokenRunPlan(context(true).ctx, true, plan)).toBe("ask");
  });

  it("keeps a refusal, an ask, a read, and every plan of a run no token reached", async () => {
    const token = context(true);
    expect(await dozoTokenRunPlan(token.ctx, true, "deny")).toBe("deny");
    expect(await dozoTokenRunPlan(token.ctx, true, "ask")).toBe("ask");
    expect(await dozoTokenRunPlan(token.ctx, false, "allow")).toBe("allow");
    expect(token.queryRaw).not.toHaveBeenCalled();
    expect(await dozoTokenRunPlan(context(false).ctx, true, "allow")).toBe("allow");
  });
});

describe("dozoTokenRunAsk", () => {
  it("drops Always allow from the card in a run a token reached", async () => {
    const block = await dozoTokenRunAsk(context(true).ctx, card);
    expect(block.kind === "ask" && block.actions?.map((action) => action.id)).toEqual([
      "allow",
      "deny",
    ]);
  });

  it("leaves other cards and runs alone", async () => {
    expect(await dozoTokenRunAsk(context(false).ctx, card)).toBe(card);
    const once = { ...card, actions: [{ id: "allow", label: "Allow once" }] } as MessageBlock;
    const token = context(true);
    expect(await dozoTokenRunAsk(token.ctx, once)).toBe(once);
    const text = { kind: "text", text: "hi" } as MessageBlock;
    expect(await dozoTokenRunAsk(token.ctx, text)).toBe(text);
    expect(token.queryRaw).not.toHaveBeenCalled();
  });
});
