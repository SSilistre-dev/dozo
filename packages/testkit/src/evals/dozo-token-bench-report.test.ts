import { describe, expect, it } from "vitest";
import type { TokenBenchReport } from "./dozo-token-bench.js";
import {
  compareTokenReports,
  runTokenBenchCli,
  summaryLine,
  topComponents,
} from "./dozo-token-bench-report.js";

function report(
  tasks: Array<[string, number]>,
  components: Partial<TokenBenchReport["totals"]["components"]> = {},
): TokenBenchReport {
  const rows = tasks.map(([id, input]) => ({
    id,
    kind: "short-chat" as const,
    modelCalls: 1,
    inputTokens: input,
    outputTokens: 5,
    cacheReadTokens: 300,
    cacheWriteTokens: 100,
    costUsd: null,
    components: {
      system: 0,
      tools: 0,
      history: 0,
      prompt: 0,
      toolCalls: 0,
      toolResults: 0,
    },
  }));
  const input = rows.reduce((n, r) => n + r.inputTokens, 0);
  return {
    version: "v1",
    fakeProvider: {} as TokenBenchReport["fakeProvider"],
    pricing: null,
    totals: {
      modelCalls: rows.length,
      promptTokens: input + 400 * rows.length,
      inputTokens: input,
      outputTokens: 5 * rows.length,
      cacheReadTokens: 300 * rows.length,
      cacheWriteTokens: 100 * rows.length,
      cacheReadShare: rows.length ? (300 * rows.length) / (input + 400 * rows.length) : 0,
      costUsd: null,
      components: {
        system: 10,
        tools: 30,
        history: 0,
        prompt: 1,
        toolCalls: 0,
        toolResults: 20,
        ...components,
      },
    },
    tasks: rows,
  };
}

describe("token benchmark report", () => {
  it("ends with the TOKEN line", () => {
    expect(summaryLine(report([["a", 100]]))).toBe("TOKEN: giris=500 cikis=5 onbellek_okuma=%60");
  });

  it("orders the largest input parts, ties by name", () => {
    expect(topComponents(report([], { system: 30 }))).toEqual([
      { component: "system", tokens: 30 },
      { component: "tools", tokens: 30 },
      { component: "toolResults", tokens: 20 },
    ]);
  });

  it("describes the difference from the previous baseline", () => {
    const now = report([
      ["a", 100],
      ["c", 7],
    ]);
    expect(compareTokenReports(undefined, now)).toEqual([
      "no previous baseline",
      "largest input parts: tools=30 toolResults=20 system=10",
    ]);
    expect(compareTokenReports(now, now)[0]).toBe("no change from the previous baseline");
    const before = {
      ...report([
        ["a", 90],
        ["b", 1],
      ]),
      version: "v0",
    };
    expect(compareTokenReports(before, now)).toEqual([
      "bench version changed: v0 -> v1",
      "a: inputTokens 90 -> 100 (+10)",
      "c: new",
      "b: removed",
      "total: promptTokens 891 -> 907, inputTokens 91 -> 107",
      "largest input parts: tools=30 toolResults=20 system=10",
    ]);
    expect(compareTokenReports(report([["a", 110]]), report([["a", 100]]))[0]).toBe(
      "a: inputTokens 110 -> 100 (-10)",
    );
  });
});

describe("token benchmark command", () => {
  const io = (files: Record<string, string>) => {
    const lines: string[] = [];
    const priced: unknown[] = [];
    return {
      lines,
      priced,
      files,
      read: (path: string) => files[path],
      write: (path: string, text: string) => {
        files[path] = text;
      },
      log: (line: string) => {
        lines.push(line);
      },
      run: async (pricing?: unknown) => {
        priced.push(pricing);
        return report([["a", 100]]);
      },
    };
  };

  it("needs a baseline path", async () => {
    const host = io({});
    expect(await runTokenBenchCli([], host)).toBe(64);
    expect(host.lines[0]).toMatch(/^usage:/);
  });

  it("fails on a missing pricing file and rejects an invalid one", async () => {
    const host = io({ "bad.json": "{}" });
    expect(await runTokenBenchCli(["base.json", "none.json"], host)).toBe(2);
    await expect(runTokenBenchCli(["base.json", "bad.json"], host)).rejects.toThrow(/Pricing/);
    expect(host.priced).toEqual([]);
  });

  it("runs, prints the difference and rewrites the baseline", async () => {
    const pricing = {
      source: "synthetic-test",
      version: "1",
      input: 1,
      output: 1,
      cacheRead: 1,
      cacheWrite: 1,
    };
    const host = io({ "base.json": "not json", "p.json": JSON.stringify(pricing) });
    expect(await runTokenBenchCli(["base.json", "p.json"], host)).toBe(0);
    expect(host.priced).toEqual([pricing]);
    expect(host.lines[0]).toBe("previous baseline is not JSON; comparing against nothing");
    expect(host.lines.at(-1)).toMatch(/^TOKEN: giris=500 /);
    expect(JSON.parse(host.files["base.json"]!).version).toBe("v1");
    const again = io({ "base.json": host.files["base.json"]! });
    expect(await runTokenBenchCli(["base.json"], again)).toBe(0);
    expect(again.priced).toEqual([undefined]);
    expect(again.lines).toContain("no change from the previous baseline");
  });
});
