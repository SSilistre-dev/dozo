import { describe, expect, it } from "vitest";
import type { BenchCall, BenchTask, WireBody } from "./dozo-token-bench.js";
import {
  fakeModelFetch,
  fakeUsage,
  listedRecords,
  prefixText,
  requestComponents,
  resolveReply,
  runBenchTask,
  runTokenBench,
  tokensOf,
} from "./dozo-token-bench.js";
import { FORM_FILL_TASKS, TOKEN_BENCH_TASKS } from "./dozo-token-bench-tasks.js";

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

describe("scripted built-in calls", () => {
  it("call a listed built-in directly and reach a deferred one through find_tool", () => {
    const reply = { builtin: "schedule_list", args: {} };
    const listed = {
      messages: [],
      tools: [{ type: "function", function: { name: "schedule_list" } }],
    };
    expect(resolveReply(reply, listed)).toEqual([{ tool: "schedule_list", args: {} }]);
    expect(resolveReply(reply, { messages: [] })).toEqual([
      { tool: "find_tool", args: { names: ["schedule_list"] } },
      { tool: "use_tool", args: { name: "schedule_list", arguments: {} } },
    ]);
    expect(resolveReply({ text: "hi" }, { messages: [] })).toEqual([{ text: "hi" }]);
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

  it("fills one form three ways, the two skill runs making the same calls", async () => {
    const [none, old, current] = FORM_FILL_TASKS as [BenchTask, BenchTask, BenchTask];
    expect(old.turns[0]?.replies).toEqual(current.turns[0]?.replies);
    expect(none.records).toBeUndefined();
    expect(old.records).toEqual(current.records);
    // Old steps carry coordinates and the typed text; new ones inputs and what each click hit.
    expect(old.turns[0]?.prompt).toContain('Type "Ada Lovelace".');
    expect(old.turns[0]?.prompt).toContain("Click left button at (208, 206).");
    const prompt = current.turns[0]!.prompt;
    expect(prompt).toContain('Click "Full name field" in "Contact – Chromium" (near 208, 206).');
    expect(prompt).toContain("Type {{full_name}}.");
    expect(prompt).toContain('- full_name: "Ada Lovelace"');
    expect(prompt).not.toContain('Type "Ada Lovelace".');
    const [a, b, c] = await Promise.all(FORM_FILL_TASKS.map((task) => runBenchTask(task)));
    expect(a!.modelCalls).toBe(9);
    expect(b!.modelCalls).toBe(5);
    expect(c!.modelCalls).toBe(5);
    // A tool result that is not the page would show as an error here, not as the fixed page.
    expect(b!.components.toolResults).toBe(c!.components.toolResults);
  });

  it("sends a run without a computer fewer tool tokens", async () => {
    const byId = (id: string) => TOKEN_BENCH_TASKS.find((task) => task.id === id)!;
    const [withComputer, without] = await Promise.all([
      runBenchTask(byId("chat-3-turns")),
      runBenchTask(byId("chat-3-turns-no-computer")),
    ]);
    expect(without.components.tools).toBeLessThan(withComputer.components.tools);
    expect(without.modelCalls).toBe(withComputer.modelCalls);
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
