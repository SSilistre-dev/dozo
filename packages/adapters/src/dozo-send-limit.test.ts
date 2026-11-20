import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  take: vi.fn(
    async (): Promise<{ full: false } | { full: true; dailySends: number }> => ({
      full: false,
    }),
  ),
}));
vi.mock("@rakazo/db", () => ({ takeDozoDailySend: db.take }));

import { buildApprovalAskBlock } from "./approval-ask.js";
import { dozoSendLimitCard, dozoSendLimitGate } from "./dozo-send-limit.js";
import type { RunContext } from "./run-context.js";

const ctx = {
  deps: { prisma: {} },
  run: { userId: "user-1" },
  bot: { id: "bot-1" },
} as unknown as RunContext;

function call(name: string, extra: Partial<Parameters<typeof dozoSendLimitGate>[1]> = {}) {
  return {
    name,
    args: { to: "someone@example.test" },
    viaConnector: false,
    connectorChanges: 0,
    approved: false,
    ...extra,
  };
}

beforeEach(() => {
  db.take.mockReset().mockResolvedValue({ full: false });
});

describe("dozoSendLimitGate", () => {
  it("counts a send that would go ahead unasked, and keeps upstream's plan below the limit", async () => {
    expect(await dozoSendLimitGate(ctx, call("send_email"), "allow")).toBe("allow");
    expect(await dozoSendLimitGate(ctx, call("message_agent"), "judge")).toBe("judge");
    expect(db.take).toHaveBeenCalledTimes(2);
    expect(db.take).toHaveBeenCalledWith({}, { userId: "user-1", botId: "bot-1", sends: 1 });
  });

  it("asks once the bot made the day's sends, whatever the mode or rules allowed", async () => {
    db.take.mockResolvedValue({ full: true, dailySends: 50 });
    expect(await dozoSendLimitGate(ctx, call("send_email"), "allow")).toBe("ask");
    expect(await dozoSendLimitGate(ctx, call("send_email"), "judge")).toBe("ask");
  });

  it("counts an app action that changes something, never one that reads", async () => {
    db.take.mockResolvedValue({ full: true, dailySends: 50 });
    const post = call("chat_post_message", { viaConnector: true, connectorChanges: 1 });
    expect(await dozoSendLimitGate(ctx, post, "allow")).toBe("ask");
    const read = call("chat_list_channels", { viaConnector: true, connectorChanges: 0 });
    expect(await dozoSendLimitGate(ctx, read, "allow")).toBe("allow");
    // A batch counts each action that changes something.
    db.take.mockResolvedValueOnce({ full: false });
    const batch = call("chat_multi_execute", { viaConnector: true, connectorChanges: 3 });
    expect(await dozoSendLimitGate(ctx, batch, "allow")).toBe("allow");
    expect(db.take).toHaveBeenLastCalledWith({}, { userId: "user-1", botId: "bot-1", sends: 3 });
    // A connector named like a built-in is still judged as a connector.
    const named = call("send_email", { viaConnector: true, connectorChanges: 0 });
    expect(await dozoSendLimitGate(ctx, named, "allow")).toBe("allow");
    expect(db.take).toHaveBeenCalledTimes(2);
  });

  it("leaves other built-ins, asks, denials and approved replays alone, uncounted", async () => {
    db.take.mockResolvedValue({ full: true, dailySends: 50 });
    for (const name of ["web_search", "write_file", "message_user", "shell", "browser_act"])
      expect(await dozoSendLimitGate(ctx, call(name), "allow")).toBe("allow");
    expect(await dozoSendLimitGate(ctx, call("send_email"), "ask")).toBe("ask");
    expect(await dozoSendLimitGate(ctx, call("send_email"), "deny")).toBe("deny");
    expect(await dozoSendLimitGate(ctx, call("send_email", { approved: true }), "allow")).toBe(
      "allow",
    );
    expect(db.take).not.toHaveBeenCalled();
  });

  it("lets a counting failure propagate rather than send uncounted", async () => {
    db.take.mockRejectedValue(new Error("database down"));
    await expect(dozoSendLimitGate(ctx, call("send_email"), "allow")).rejects.toThrow(
      "database down",
    );
  });
});

describe("dozoSendLimitCard", () => {
  it("says why a held send asks, and offers Allow once and Deny only", async () => {
    db.take.mockResolvedValue({ full: true, dailySends: 25 });
    const held = call("send_email");
    await dozoSendLimitGate(ctx, held, "allow");
    const block = buildApprovalAskBlock(
      "effect-1",
      "send_email",
      held.args,
      [],
      dozoSendLimitCard(held.args, undefined),
    );
    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") return;
    expect(block.detail).toContain(
      "Over the daily limit: this bot may make 25 sends a day without asking.",
    );
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
  });

  it("leaves every other card as upstream builds it", () => {
    const options = { reviewReason: "Off task" };
    expect(dozoSendLimitCard({ to: "x" }, options)).toBe(options);
    expect(dozoSendLimitCard({ to: "x" }, undefined)).toBeUndefined();
  });
});
