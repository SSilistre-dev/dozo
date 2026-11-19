import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "../../../adapters/src/builtin.tool-definition.js";
import { PiAgentRuntime } from "../../../adapters/src/pi-runtime.js";
import type { BenchCall, ScriptedReply } from "./dozo-token-bench.js";
import { BENCH_MODEL, benchInstructions, fakeModelFetch } from "./dozo-token-bench.js";

/**
 * The cacheable prefix: two consecutive turns of one bot in one thread must send the provider the
 * same system prompt and the same tool definitions, byte for byte. A timestamp, a random id or a
 * list whose order changes would make every turn pay for the whole prefix again.
 */
async function twoTurns(options: {
  replies: ScriptedReply[];
  secondTurnTools?: ConnectorTool[];
  toolResult?: unknown;
}) {
  const calls: BenchCall[] = [];
  const runtime = new PiAgentRuntime({ modelFetch: fakeModelFetch(options.replies, calls) });
  const history: AgentRunRequest["history"] = [];
  const turns = [
    { prompt: "First question.", tools: builtinAgentTools },
    { prompt: "Second question.", tools: options.secondTurnTools ?? builtinAgentTools },
  ];
  const callsPerTurn: number[] = [];
  for (const [index, turn] of turns.entries()) {
    let answer = "";
    for await (const event of runtime.run({
      botId: "prefix-bot",
      threadId: "prefix-thread",
      runId: `prefix-run-${index + 1}`,
      prompt: turn.prompt,
      instructions: benchInstructions(),
      history: [...history],
      tools: turn.tools,
      model: BENCH_MODEL,
      executeTool: async () => options.toolResult ?? { ok: true },
    }))
      if (event.type === "done") answer = event.text ?? "";
    history.push({ role: "user", content: turn.prompt }, { role: "assistant", content: answer });
    callsPerTurn.push(calls.length);
  }
  const system = (call: BenchCall) =>
    JSON.stringify(call.body.messages.filter((m) => m.role === "system" || m.role === "developer"));
  const tools = (call: BenchCall) => JSON.stringify(call.body.tools ?? []);
  return { calls, callsPerTurn, system, tools };
}

describe("cacheable prefix across consecutive turns", () => {
  it("sends the same system prompt and tool definitions on both turns", async () => {
    const { calls, system, tools } = await twoTurns({
      replies: [{ text: "First answer." }, { text: "Second answer." }],
    });
    expect(calls).toHaveLength(2);
    const [first, second] = calls as [BenchCall, BenchCall];
    expect(JSON.parse(system(first))).toHaveLength(1);
    expect(first.body.tools?.length).toBeGreaterThan(10);
    expect(system(second)).toBe(system(first));
    expect(tools(second)).toBe(tools(first));
    // The whole first request is a prefix of the second: turn 2 reads all turn 1 wrote.
    expect(second.cacheReadTokens).toBe(first.cacheWriteTokens);
    expect(first.cacheWriteTokens).toBeGreaterThan(0);
  });

  it("keeps the prefix through a turn that used a tool", async () => {
    const { calls, callsPerTurn, system, tools } = await twoTurns({
      replies: [
        { tool: "recall_memory", args: { query: "plan" } },
        { text: "First answer." },
        { text: "Second answer." },
      ],
      toolResult: { results: [{ memory: "The plan ships after review." }] },
    });
    expect(callsPerTurn).toEqual([2, 3]);
    for (const call of calls.slice(1)) {
      expect(system(call)).toBe(system(calls[0]!));
      expect(tools(call)).toBe(tools(calls[0]!));
    }
  });

  it("sends the tools in the same order when the server lists them in another order", async () => {
    const { calls, tools } = await twoTurns({
      replies: [{ text: "First answer." }, { text: "Second answer." }],
      secondTurnTools: [...builtinAgentTools].reverse(),
    });
    expect(tools(calls[1]!)).toBe(tools(calls[0]!));
  });
});
