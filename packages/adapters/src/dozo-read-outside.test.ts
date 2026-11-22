import { describe, expect, it, vi } from "vitest";
import {
  markHistoryReadOutside,
  markRunReadOutside,
  runReadOutsideContent,
} from "./dozo-read-outside.js";
import type { RunContext } from "./run-context.js";
import { isRunTainted, markReadOutsideContent } from "./run-context.js";

// markReadOutsideContent is the branded one (dozo/brand/brand.json). Runs on the staged tree.

function run(options: { attempts?: number; outsideMessage?: boolean; tainted?: boolean } = {}) {
  const count = vi.fn(async () => options.attempts ?? 1);
  return {
    count,
    ctx: {
      runId: "run-1",
      deps: { prisma: { attempt: { count } } },
      // A run someone else started begins tainted; that alone says nothing about what it read.
      state: { tainted: Boolean(options.tainted), earlierAttempt: undefined },
      trust: { receivedOutsideMessage: async () => options.outsideMessage ?? false },
    } as unknown as RunContext,
  };
}

describe("runReadOutsideContent", () => {
  it("is false for a run that read nothing, even one someone else started", async () => {
    expect(await runReadOutsideContent(run().ctx)).toBe(false);
    expect(await runReadOutsideContent(run({ tainted: true }).ctx)).toBe(false);
  });

  it("is true once a tool result marked the run, as every marking call does", async () => {
    const { ctx } = run({ tainted: true });
    await markReadOutsideContent(ctx);
    expect(ctx.state.tainted).toBe(true);
    expect(await runReadOutsideContent(ctx)).toBe(true);
  });

  it("is true for a run whose history replays a kept tool result, marked at assembly", async () => {
    const step = (call: Record<string, unknown>) => [
      {
        role: "assistant" as const,
        content: "",
        segments: [{ steps: [{ calls: [{ name: "web_fetch", arguments: "{}", ...call }] }] }],
      },
    ];
    const clean = run();
    markHistoryReadOutside(clean.ctx.state, step({}) as never);
    markHistoryReadOutside(clean.ctx.state, [{ role: "user", content: "Hi" }]);
    expect(await runReadOutsideContent(clean.ctx)).toBe(false);
    const replayed = run();
    markHistoryReadOutside(replayed.ctx.state, step({ result: "<page text>" }) as never);
    expect(await runReadOutsideContent(replayed.ctx)).toBe(true);
  });

  it("is true for a later attempt, which may have restored untrusted results", async () => {
    const { ctx, count } = run({ attempts: 2 });
    expect(await runReadOutsideContent(ctx)).toBe(true);
    // The count is the one isRunTainted reads: one query for both.
    expect(await isRunTainted(ctx)).toBe(true);
    expect(count).toHaveBeenCalledOnce();
  });

  it("is true once an outside message steered the run", async () => {
    expect(await runReadOutsideContent(run({ outsideMessage: true }).ctx)).toBe(true);
  });

  it("is kept per attempt: another attempt's state is not marked", async () => {
    const first = run();
    const second = run();
    markRunReadOutside(first.ctx.state);
    expect(await runReadOutsideContent(second.ctx)).toBe(false);
  });
});
