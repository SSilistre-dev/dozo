import { describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin.tool-definition.js";

// A call wrapped in use_tool reaches the executor, and so the tool gate (gateToolCall, which
// dozoHostedCommandHold is wired into), under the wrapped tool's own name and arguments, so a
// file write, a command or screen input is held exactly as a direct call is.

const fake = vi.hoisted(() => ({
  invoke: { name: "", args: {} as Record<string, unknown> },
  exposed: [] as string[],
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined as string | undefined, messages: [] as unknown[] };
    private readonly tools: FakeTool[];
    constructor(options: { initialState: { tools: FakeTool[] } }) {
      this.tools = options.initialState.tools;
      fake.exposed = this.tools.map((tool) => tool.name);
    }
    subscribe() {}
    async prompt() {
      const target = this.tools.find((tool) => tool.name === fake.invoke.name);
      if (!target) throw new Error(`${fake.invoke.name} was not exposed`);
      await target.execute(
        "call-1",
        target.prepareArguments?.(fake.invoke.args) ?? fake.invoke.args,
      );
    }
    async waitForIdle() {}
    async continue() {}
    steer() {}
    followUp() {}
    abort() {}
  },
}));
type FakeTool = {
  name: string;
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) => ({ provider: "test", id: modelId }),
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
    },
  }),
}));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

const { PiAgentRuntime } = await import("./pi-runtime.js");

const tool = (name: string) => {
  const found = builtinAgentTools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
};

describe("a call wrapped in use_tool", () => {
  it.each([
    ["write_file", { path: ".profile", content: "echo hi\n" }],
    ["shell", { command: "npm install" }],
    ["computer_act", { actions: [{ kind: "type", text: "ls" }] }],
  ] as const)("reaches the executor as %s itself", async (name, args) => {
    fake.invoke = { name: "use_tool", args: { name, arguments: args } };
    const executeTool = vi.fn(async () => ({ ok: true }));
    const runtime = new PiAgentRuntime();
    for await (const _event of runtime.run(
      {
        botId: "b",
        threadId: "t",
        runId: "r",
        prompt: "set up the project",
        instructions: "",
        history: [],
        // A deferred tool makes the runtime expose use_tool.
        tools: [tool(name), tool("schedule_cancel")],
        model: { provider: "test", id: "use-tool-test-model" },
        executeTool,
      },
      {
        operationId: "1",
        traceId: "1",
        spaceId: "w",
        userId: "u",
        signal: new AbortController().signal,
      },
    )) {
      // Exhaust the runtime event stream so the tool call completes.
    }
    expect(fake.exposed).toContain("use_tool");
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(
      name,
      expect.objectContaining(args),
      expect.any(String),
      undefined,
      expect.anything(),
    );
  });
});
