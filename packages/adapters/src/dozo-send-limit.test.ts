import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  take: vi.fn(
    async (): Promise<{ full: false } | { full: true; dailySends: number }> => ({
      full: false,
    }),
  ),
  report: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@rakazo/db")>();
  return {
    takeDozoDailySend: db.take,
    readJsonColumn: db.read.mockImplementation(real.readJsonColumn),
    JsonColumnMismatchError: real.JsonColumnMismatchError,
    reportJsonColumnOnce: db.report,
  };
});

import { buildApprovalAskBlock } from "./approval-ask.js";
import { dozoSendLimitCard, dozoSendLimitGate, pageSends } from "./dozo-send-limit.js";
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

const fill = (text = "hello") => ({ kind: "fill", ref: "e1", text });
const click = { kind: "click", ref: "e2" };
const enter = { kind: "type", ref: "e1", text: "hello\n" };

describe("pageSends", () => {
  it.each([
    ["a click with nothing put in", [click], false, 0, false],
    ["a fill and nothing pressed", [fill()], false, 0, true],
    ["a fill then a click", [fill(), click], false, 1, false],
    ["two fills then a click", [fill(), fill("b"), click], false, 1, false],
    ["a click on input from an earlier call", [click], true, 1, false],
    ["text typed with Enter", [enter], false, 1, false],
    ["text typed without Enter", [{ kind: "type", ref: "e1", text: "a" }], false, 0, true],
    ["a carriage return", [{ kind: "type", ref: "e1", text: "a\r" }], false, 1, false],
    ["two forms in one call", [fill(), click, fill(), click], false, 2, false],
    ["a second click after a send", [fill(), click, click], false, 1, false],
    [
      "a file put in, then sent",
      [{ kind: "upload", ref: "e3", paths: ["a"] }, click],
      false,
      1,
      false,
    ],
    [
      "a saved login put in, then sent",
      [{ kind: "fill_secret", ref: "e1" }, click],
      false,
      1,
      false,
    ],
    ["a code put in, then sent", [{ kind: "fill_code", ref: "e1" }, click], false, 1, false],
    ["a card put in, then sent", [{ kind: "fill_card" }, click], false, 1, false],
    ["a pay token handed over, then sent", [{ kind: "fill_pay_token" }, click], false, 1, false],
    ["an unknown step", [{ kind: "scroll" }, { kind: 3 }, {}], true, 0, true],
  ])("%s", (_name, steps, pending, sends, after) => {
    expect(pageSends(steps, pending)).toEqual({ sends, pending: after });
  });
});

describe("dozoSendLimitGate on page presses", () => {
  const earlier = vi.fn(async (): Promise<Array<{ id: string; request: unknown }>> => []);
  const pageCtx = {
    deps: { prisma: { externalEffect: { findMany: earlier } } },
    runId: "run-1",
    run: { userId: "user-1" },
    bot: { id: "bot-1" },
  } as unknown as RunContext;
  const act = (...actions: unknown[]) => call("browser_act", { args: { actions } });

  beforeEach(() => {
    earlier.mockReset().mockResolvedValue([]);
    db.report.mockReset();
  });

  it("counts a press that sends what the same call put in, without reading earlier calls", async () => {
    expect(await dozoSendLimitGate(pageCtx, act(fill(), click), "allow")).toBe("allow");
    expect(db.take).toHaveBeenCalledWith(pageCtx.deps.prisma, {
      userId: "user-1",
      botId: "bot-1",
      sends: 1,
    });
    expect(earlier).not.toHaveBeenCalled();
    db.take.mockResolvedValue({ full: true, dailySends: 10 });
    expect(await dozoSendLimitGate(pageCtx, act(enter), "allow")).toBe("ask");
  });

  it("counts a press that sends what an earlier call of the run put in", async () => {
    earlier.mockResolvedValue([
      { id: "e1", request: { actions: [fill()] } },
      { id: "e2", request: { actions: [{ kind: "fill_secret", ref: "e1" }] } },
    ]);
    expect(await dozoSendLimitGate(pageCtx, act(click), "allow")).toBe("allow");
    expect(earlier).toHaveBeenCalledWith({
      where: { runId: "run-1", kind: "browser_act", status: { not: "denied" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, request: true },
    });
    expect(db.take).toHaveBeenCalledTimes(1);
  });

  it("never counts navigation, reading, or a press on nothing put in", async () => {
    earlier.mockResolvedValue([{ id: "e1", request: { actions: [fill(), click] } }]);
    expect(await dozoSendLimitGate(pageCtx, act(click, click), "allow")).toBe("allow");
    expect(await dozoSendLimitGate(pageCtx, act(fill()), "allow")).toBe("allow");
    for (const name of ["browser_navigate", "browser_snapshot"])
      expect(
        await dozoSendLimitGate(pageCtx, call(name, { args: { actions: [click] } }), "allow"),
      ).toBe("allow");
    expect(db.take).not.toHaveBeenCalled();
  });

  it("leaves out an earlier call stored in another shape, and reports it", async () => {
    earlier.mockResolvedValue([
      { id: "e1", request: { actions: "fill" } },
      { id: "e2", request: { actions: [click] } },
    ]);
    expect(await dozoSendLimitGate(pageCtx, act(click), "allow")).toBe("allow");
    expect(db.take).not.toHaveBeenCalled();
    expect(db.report).toHaveBeenCalledWith("browser_act request left out of the daily send count", {
      table: "external_effects",
      column: "request",
      id: "e1",
    });
  });

  it("lets a failure to read earlier calls propagate", async () => {
    earlier.mockRejectedValue(new Error("database down"));
    await expect(dozoSendLimitGate(pageCtx, act(click), "allow")).rejects.toThrow("database down");
    earlier.mockResolvedValue([{ id: "e1", request: { actions: [] } }]);
    db.read.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    await expect(dozoSendLimitGate(pageCtx, act(click), "allow")).rejects.toThrow("unexpected");
  });

  it("does not count a press that asks, is refused or was approved", async () => {
    expect(await dozoSendLimitGate(pageCtx, act(fill(), click), "ask")).toBe("ask");
    expect(
      await dozoSendLimitGate(pageCtx, { ...act(fill(), click), approved: true }, "allow"),
    ).toBe("allow");
    expect(db.take).not.toHaveBeenCalled();
  });
});
