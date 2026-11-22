import { describe, expect, it, vi } from "vitest";
import {
  markAssemblyReadOutside,
  markRunReadHistory,
  markRunReadOutside,
  runReadHistory,
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
    markAssemblyReadOutside(clean.ctx.state, step({}) as never, {});
    markAssemblyReadOutside(clean.ctx.state, [{ role: "user", content: "Hi" }], {});
    expect(await runReadOutsideContent(clean.ctx)).toBe(false);
    const replayed = run();
    markAssemblyReadOutside(replayed.ctx.state, step({ result: "<page text>" }) as never, {});
    expect(await runReadOutsideContent(replayed.ctx)).toBe(true);
  });

  // The content sources initiallyTainted counts (run-assembly-capabilities.ts), all of them.
  it("is true for a run that restores a saved turn, which may carry untrusted results", async () => {
    const restored = run();
    markAssemblyReadOutside(restored.ctx.state, [], { turnCheckpoint: "<saved turn>" });
    expect(await runReadOutsideContent(restored.ctx)).toBe(true);
  });

  it("is true for a run whose saved turn could not be read", async () => {
    const unreadable = run();
    markAssemblyReadOutside(unreadable.ctx.state, [], {
      checkpointLoadError: new Error("Unsupported turn checkpoint"),
    });
    expect(await runReadOutsideContent(unreadable.ctx)).toBe(true);
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

describe("runReadHistory", () => {
  it("is true once the run called a history tool, and kept per attempt", () => {
    const first = run();
    const second = run();
    expect(runReadHistory(first.ctx.state)).toBe(false);
    markRunReadHistory(first.ctx.state, "skill_read");
    expect(runReadHistory(first.ctx.state)).toBe(false);
    markRunReadHistory(first.ctx.state, "search_history");
    expect(runReadHistory(first.ctx.state)).toBe(true);
    markRunReadHistory(second.ctx.state, "read_history");
    expect(runReadHistory(second.ctx.state)).toBe(true);
    expect(runReadHistory(run().ctx.state)).toBe(false);
  });

  it("is not reading outside content: the memory rule and retention do not see it", async () => {
    const { ctx } = run();
    markRunReadHistory(ctx.state, "read_history");
    expect(await runReadOutsideContent(ctx)).toBe(false);
  });
});
