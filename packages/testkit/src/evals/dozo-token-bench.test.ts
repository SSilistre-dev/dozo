import { describe, expect, it } from "vitest";
import type { BenchCall, BenchTask, WireBody } from "./dozo-token-bench.js";
import {
  fakeModelFetch,
  fakeUsage,
  listedRecords,
  prefixText,
  requestComponents,
  runBenchTask,
  runTokenBench,
  tokensOf,
} from "./dozo-token-bench.js";
import { TOKEN_BENCH_TASKS } from "./dozo-token-bench-tasks.js";

const body = (text: string, extra: WireBody["messages"] = []): WireBody => ({
  tools: [{ type: "function", function: { name: "t" } }],
  messages: [{ role: "system", content: text }, ...extra],
});

/** Synthetic rates of one USD per million in every bucket: a test value, not a real price. */
const unitPricing = {
  source: "synthetic-test",
  version: "1",
  input: 1,
  output: 1,
  cacheRead: 1,
  cacheWrite: 1,
};

describe("listed records", () => {
  it("lists rows in creation order, then by id, whatever order the database returned", () => {
    const rows = [
      { id: "b", createdAt: "2026-01-02", name: "B" },
      { id: "a", createdAt: "2026-01-02", name: "A" },
      { id: "c", createdAt: "2026-01-01", name: "C" },
    ];
    expect(listedRecords(rows).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(listedRecords(rows, [2, 0, 1])).toEqual(listedRecords(rows));
  });
});

describe("fake model usage", () => {
  it("counts a quarter token per byte and splits a request into its parts", () => {
    expect(tokensOf("abcd")).toBe(1);
    expect(tokensOf("abcde")).toBe(2);
    const parts = requestComponents({
      tools: [],
      messages: [
        { role: "developer", content: "rules" },
        { role: "user", content: "earlier" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "now" },
        { role: "assistant", tool_calls: [{ id: "1" }] },
        { role: "tool", content: "result" },
      ],
    });
    expect(parts.tools).toBe(0);
    expect(parts.system).toBeGreaterThan(0);
    expect(parts.history).toBeGreaterThan(0);
    expect(parts.prompt).toBeGreaterThan(0);
    expect(parts.toolCalls).toBeGreaterThan(0);
    expect(parts.toolResults).toBeGreaterThan(0);
  });

  it("caches nothing below the minimum size", () => {
    const written: string[] = [];
    const { usage } = fakeUsage(body("short"), written, 3);
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 0, cache_write_tokens: 0 });
    expect(written).toEqual([]);
    expect(usage.total_tokens).toBe(usage.prompt_tokens + 3);
  });

  it("reads the block-aligned prefix an earlier request wrote, and writes the rest", () => {
    const written: string[] = [];
    const long = "x".repeat(8000);
    const first = fakeUsage(body(long), written, 0).usage;
    expect(first.prompt_tokens_details.cached_tokens).toBe(0);
    expect(first.prompt_tokens_details.cache_write_tokens).toBe(
      Math.floor(first.prompt_tokens / 128) * 128,
    );
    const second = fakeUsage(
      body(long, [{ role: "user", content: "y".repeat(2000) }]),
      written,
      0,
    ).usage;
    expect(second.prompt_tokens_details.cached_tokens).toBe(
      first.prompt_tokens_details.cache_write_tokens,
    );
    // A changed first byte shares nothing, so nothing is read.
    const changed = fakeUsage(body(`z${long}`), written, 0).usage;
    expect(changed.prompt_tokens_details.cached_tokens).toBe(0);
    expect(written).toHaveLength(3);
    expect(prefixText(body("a")).startsWith('[{"type"')).toBe(true);
    expect(prefixText({ messages: [] })).toBe("[]");
  });

  it("answers scripted text, single and parallel tool calls, then Done", async () => {
    const calls: BenchCall[] = [];
    const fetch = fakeModelFetch(
      [
        { text: "hi" },
        { tool: "a", args: { x: 1 } },
        {
          tools: [
            { tool: "a", args: {} },
            { tool: "b", args: {} },
          ],
        },
      ],
      calls,
    );
    const send = async () =>
      (await fetch("http://bench.test", { body: JSON.stringify(body("q")) })).text();
    expect(await send()).toContain('"content":"hi"');
    expect(await send()).toContain('"name":"a"');
    const parallel = await send();
    expect(parallel).toContain('"name":"b"');
    expect(parallel).toContain('"finish_reason":"tool_calls"');
    expect(await send()).toContain('"content":"Done."');
    expect(calls.map((c) => c.id)).toEqual(["call-1", "call-2", "call-3", "call-4"]);
    expect(calls[0]!.body.messages[0]!.content).toBe("q");
  });
});

describe("token benchmark", () => {
  it("has a fixed set of 15 to 25 tasks covering every kind", () => {
    expect(TOKEN_BENCH_TASKS.length).toBeGreaterThanOrEqual(15);
    expect(TOKEN_BENCH_TASKS.length).toBeLessThanOrEqual(25);
    expect(new Set(TOKEN_BENCH_TASKS.map((t) => t.id)).size).toBe(TOKEN_BENCH_TASKS.length);
    expect(new Set(TOKEN_BENCH_TASKS.map((t) => t.kind))).toEqual(
      new Set(["short-chat", "long-tool-result", "multi-page", "long-history", "memory-recall"]),
    );
    const history = TOKEN_BENCH_TASKS.find((t) => t.kind === "long-history");
    expect(history?.history?.length).toBeGreaterThanOrEqual(60);
  });

  it("gives the same numbers on a second run", async () => {
    const first = await runTokenBench(TOKEN_BENCH_TASKS);
    const second = await runTokenBench(TOKEN_BENCH_TASKS);
    expect(second).toEqual(first);
    expect(first.totals.modelCalls).toBeGreaterThan(TOKEN_BENCH_TASKS.length);
    expect(first.totals.cacheReadTokens).toBeGreaterThan(0);
    expect(first.totals.cacheWriteTokens).toBeGreaterThan(0);
    expect(first.totals.costUsd).toBeNull();
    expect(first.pricing).toBeNull();
    for (const task of first.tasks)
      expect(task.inputTokens + task.cacheReadTokens + task.cacheWriteTokens).toBe(
        Object.values(task.components).reduce((n, v) => n + v, 0),
      );
  }, 120_000);

  it("prices calls only with a pricing table it is given", async () => {
    const task: BenchTask = {
      id: "priced",
      kind: "short-chat",
      turns: [{ prompt: "Hi", replies: [{ tool: "recall_memory", args: { query: "q" } }] }],
    };
    const result = await runBenchTask(task, unitPricing);
    const tokens =
      result.inputTokens + result.outputTokens + result.cacheReadTokens + result.cacheWriteTokens;
    expect(result.costUsd).toBeCloseTo(tokens / 1_000_000, 12);
    // No fixture output: the tool answers a neutral note and the script then says Done.
    expect(result.modelCalls).toBe(2);
    expect(result.components.toolResults).toBeGreaterThan(0);
    const report = await runTokenBench([task], unitPricing);
    expect(report.pricing).toEqual({ source: "synthetic-test", version: "1" });
    expect(report.totals.costUsd).toBeCloseTo(tokens / 1_000_000, 12);
    const empty = await runTokenBench([]);
    expect(empty.totals).toMatchObject({ modelCalls: 0, promptTokens: 0, cacheReadShare: 0 });
  });
});
