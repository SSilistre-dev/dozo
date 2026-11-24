import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_AGENT_PROVIDER_ID,
  CODEX_SIGNED_OUT_ERROR,
  codexAgentDriver,
  codexAnswer,
  codexApproval,
} from "./codex/dozo-codex-agent.js";
import type { AgentDriver, AgentSession, AgentSessionEvent } from "./dozo-agent.js";
import {
  AGENT_INTERRUPTED_ERROR,
  AGENT_OWN_RUNS_ONLY,
  AGENT_RECONNECT_ERROR,
  AGENT_TOKEN_TEXT,
  ALLOW_ONCE,
  agentInput,
  DECLINE,
  enabledAgentProviders,
  liveAgentRuns,
  withAgentRuntime,
} from "./dozo-agent.js";
import { startAgentBridge } from "./dozo-agent-bridge.js";
import { allowlistedEnv as codexEnv } from "./dozo-agent-rpc.js";
import { AGENT_CATALOG_ERROR, registerLocalCliProviders } from "./dozo-cli-providers.js";
import { cliModelRuntime, ownRun } from "./dozo-cli-runtime.js";

const FAKE = fileURLToPath(
  new URL("./codex/dozo-fake-app-server.test-support.mjs", import.meta.url),
);
const SECRETS = { DATABASE_URL: "postgres://u:fake@db.invalid/x", ENCRYPTION_KEY: "fake-key" };
let log: string;

type Logged = {
  started?: string[];
  env?: Record<string, string>;
  received?: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
  decision?: unknown;
  mcpTools?: string[];
  unknownAnswer?: { error?: unknown };
};

/** The person's computer with a fake `codex` on their login PATH, agent mode turned on. */
function computer(scenario: string, options: { enabled?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dozo-person-home-"));
  const bin = mkdtempSync(join(tmpdir(), "dozo-person-bin-"));
  const data = mkdtempSync(join(tmpdir(), "dozo-server-data-"));
  log = join(bin, "calls.log");
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "${scenario}" "${log}" "$@"\n`,
    { mode: 0o755 },
  );
  if (options.enabled !== false)
    writeFileSync(join(data, "dozo-agent-tools"), `${CODEX_AGENT_PROVIDER_ID}\n`);
  vi.stubEnv("HOST_USER_HOME", home);
  vi.stubEnv("HOST_USER_PATH", `${bin}:/usr/bin:/bin`);
  vi.stubEnv("DATA_DIR", data);
  return { home, data };
}

const logged = (): Logged[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Logged)
    : [];
const sent = (method: string) => logged().filter((entry) => entry.received?.method === method);

const model: AgentRuntime = {
  describe: () => ({}) as ReturnType<AgentRuntime["describe"]>,
  abort: vi.fn(),
  async *run() {
    yield { type: "text", text: "from the model" };
  },
};

function runtime(
  access: () => Promise<string | undefined> = async () => undefined,
  runAllowed: () => Promise<string | undefined> = async () => undefined,
) {
  return withAgentRuntime(model, [codexAgentDriver], { accessCheck: access, runAllowed });
}

function request(over: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    runId: `run-${Math.random().toString(16).slice(2)}`,
    prompt: "Say hello",
    instructions: "You are a helpful bot.",
    history: [],
    tools: [],
    model: { provider: CODEX_AGENT_PROVIDER_ID, id: "gpt-6-luna", apiKey: "dozo-cli-account:home" },
    ...over,
  } as AgentRunRequest;
}

async function collect(stream: AsyncIterable<AgentRuntimeEvent>) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
const textOf = (events: AgentRuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");

describe.skipIf(process.platform === "win32")("agent mode with Codex", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("leaves every other run to the model runtime, and lists nothing on a hosted server", async () => {
    vi.stubEnv("HOST_USER_HOME", undefined);
    const events = await collect(
      runtime().run(request({ model: { provider: "openrouter", id: "m" } }), {}),
    );
    expect(textOf(events)).toBe("from the model");
    await expect(collect(runtime().run(request(), {}))).rejects.toThrow(/not turned on/);
    // On a hosted server (no person's computer) the catalog has no agent in it at all.
    expect(
      registerLocalCliProviders(builtinModels() as MutableModels).getProvider(
        CODEX_AGENT_PROVIDER_ID,
      ),
    ).toBeUndefined();
  });

  it("runs the agent only once its mode is turned on for this server, and lists it either way", async () => {
    computer("reply", { enabled: false });
    expect(enabledAgentProviders().size).toBe(0);
    await expect(collect(runtime().run(request(), {}))).rejects.toThrow(/not turned on/);
    expect(
      registerLocalCliProviders(builtinModels() as MutableModels).getProvider(
        CODEX_AGENT_PROVIDER_ID,
      ),
    ).toBeDefined();
    computer("reply");
    const models = registerLocalCliProviders(builtinModels() as MutableModels);
    const provider = models.getProvider(CODEX_AGENT_PROVIDER_ID);
    expect(provider?.name).toBe("Codex agent");
    const listed = models.getModels(CODEX_AGENT_PROVIDER_ID);
    expect(listed.length).toBeGreaterThan(0);
    const message = await models
      .streamSimple(listed[0]!, { messages: [] }, { apiKey: "x" })
      .result();
    expect(message.errorMessage).toBe(AGENT_CATALOG_ERROR);
  });

  it("runs the turn in Codex, asking only the person and with no server secret", async () => {
    computer("reply");
    const events = await collect(runtime().run(request(), {}));
    expect(textOf(events)).toBe("Hello there");
    expect(events.at(-1)).toEqual({ type: "done" });
    const [start] = sent("thread/start");
    expect(start?.received?.params).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      developerInstructions: "You are a helpful bot.",
      config: { mcp_servers: { dozo: { command: process.execPath } } },
    });
    expect(JSON.stringify(start?.received?.params)).not.toMatch(/danger|bypass|acceptForSession/);
    // Signed in is checked before the turn, never after.
    const order = logged().flatMap((entry) =>
      entry.received?.method ? [entry.received.method] : [],
    );
    expect(order.indexOf("account/read")).toBeLessThan(order.indexOf("turn/start"));
    const env = logged().find((entry) => entry.started)?.env ?? {};
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(liveAgentRuns().size).toBe(0);
  });

  it("starts no turn when Codex is not signed in", async () => {
    computer("signed-out");
    await expect(collect(runtime().run(request(), {}))).rejects.toThrow(CODEX_SIGNED_OUT_ERROR);
    expect(sent("turn/start")).toEqual([]);
  });

  it("refuses a run the person did not start themselves, before Codex starts", async () => {
    computer("reply");
    await expect(
      collect(runtime(undefined, async () => "Only your own messages.").run(request(), {})),
    ).rejects.toThrow("Only your own messages.");
    expect(logged()).toEqual([]);
  });

  it("refuses a connection that was not made in settings", async () => {
    computer("reply");
    const forged = request({
      model: { provider: CODEX_AGENT_PROVIDER_ID, id: "m", apiKey: "sk-x" },
    });
    await expect(collect(runtime().run(forged, {}))).rejects.toThrow(AGENT_RECONNECT_ERROR);
    expect(logged()).toEqual([]);
  });

  it("refuses a turn the access check refuses", async () => {
    computer("reply");
    await expect(
      collect(runtime(async () => "Only one person.").run(request(), {})),
    ).rejects.toThrow("Only one person.");
    expect(logged()).toEqual([]);
  });

  it("asks the person on Codex's behalf, and answers once with what they chose", async () => {
    computer("command");
    const first = request();
    const asked = await collect(runtime().run(first, {}));
    expect(asked.find((event) => event.type === "progress")).toEqual({
      type: "progress",
      text: "Running ls -la",
    });
    expect(asked.at(-1)).toEqual({
      type: "ask",
      text: "Codex wants to run a command.",
      detail: "ls -la\nin /work\nto look around",
      actions: [
        { id: "allow-once", label: ALLOW_ONCE },
        { id: "decline", label: DECLINE },
      ],
    });
    // The same process waits, kept for the run.
    expect(liveAgentRuns().has(first.runId)).toBe(true);
    const resumed = await collect(
      runtime().run(
        request({
          runId: first.runId,
          resumeToolResult: { content: [{ type: "text", text: ALLOW_ONCE }] },
        }),
        {},
      ),
    );
    expect(textOf(resumed)).toBe('decision "accept"');
    expect(logged().find((entry) => entry.decision)?.decision).toEqual({ decision: "accept" });
    expect(sent("thread/start")).toHaveLength(1);
  });

  it("declines whatever else comes back, and never for the session", async () => {
    computer("command");
    const first = request();
    await collect(runtime().run(first, {}));
    const resumed = await collect(
      runtime().run(
        request({
          runId: first.runId,
          resumeToolResult: { content: [{ type: "text", text: "Allow always" }] },
        }),
        {},
      ),
    );
    expect(textOf(resumed)).toBe('decision "decline"');
  });

  it("grants more access for this turn only, or none", async () => {
    computer("permissions");
    const first = request();
    await collect(runtime().run(first, {}));
    await collect(
      runtime().run(
        request({
          runId: first.runId,
          resumeToolResult: { content: [{ type: "text", text: ALLOW_ONCE }] },
        }),
        {},
      ),
    );
    expect(logged().find((entry) => entry.decision)?.decision).toEqual({
      permissions: { network: { enabled: true } },
      scope: "turn",
    });
  });

  it("ends a run as interrupted when its process is gone, never starting it again", async () => {
    computer("command");
    const first = request();
    await collect(runtime().run(first, {}));
    // Another process, or this one after a restart, picks the run up.
    const kept = liveAgentRuns() as Map<string, { session: { close(): void } }>;
    kept.get(first.runId)?.session.close();
    kept.delete(first.runId);
    await expect(
      collect(
        runtime().run(
          request({
            runId: first.runId,
            resumeToolResult: { content: [{ type: "text", text: ALLOW_ONCE }] },
          }),
          {},
        ),
      ),
    ).rejects.toThrow(AGENT_INTERRUPTED_ERROR);
    expect(sent("thread/start")).toHaveLength(1);
  });

  it("runs Dozo's own tools through the run's executor", async () => {
    computer("tool");
    const executeTool = vi.fn(async () => ({ content: [{ type: "text", text: "sunny" }] }));
    const tools = [
      { name: "lookup", description: "Look up the weather.", inputSchema: { type: "object" } },
    ];
    const events = await collect(runtime().run(request({ tools, executeTool }), {}));
    expect(textOf(events)).toBe("tool said sunny");
    expect(executeTool).toHaveBeenCalledWith(
      "lookup",
      { city: "Oslo" },
      expect.stringMatching(/:bridge-1$/),
    );
    expect(logged().find((entry) => entry.mcpTools)?.mcpTools).toEqual(["lookup"]);
  });

  it("ends the turn when a Dozo tool waits for approval, and goes on in the next one", async () => {
    computer("tool");
    const paused = {
      kind: "agent_tool_result",
      content: [],
      details: { approval: "paused" },
      terminate: true,
    };
    const tools = [
      { name: "lookup", description: "Look up the weather.", inputSchema: { type: "object" } },
    ];
    const first = request({ tools, executeTool: vi.fn(async () => paused) });
    const events = await collect(runtime().run(first, {}));
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(sent("turn/interrupt")).toHaveLength(1);
    const next = await collect(
      runtime().run(
        request({ runId: first.runId, tools, executeTool: vi.fn(), prompt: "continue: approved" }),
        {},
      ),
    );
    expect(textOf(next)).toBe("after approval");
    expect(sent("thread/start")).toHaveLength(1);
  });

  it("says when the account's usage ran out and when it opens again", async () => {
    computer("limit");
    await expect(collect(runtime().run(request(), {}))).rejects.toThrow(
      /Codex usage limit reached; try again in ~120 min\./,
    );
  });

  it("stops at once when Codex's sign-in is refused, instead of letting it retry", async () => {
    computer("unauthorized");
    const run = request();
    await expect(collect(runtime().run(run, {}))).rejects.toThrow(CODEX_SIGNED_OUT_ERROR);
    // Its process ends with the run, so nothing is retried.
    expect(liveAgentRuns().has(run.runId)).toBe(false);
  });

  it("answers what it does not handle with an error, not an approval", async () => {
    computer("unknown-request");
    expect(textOf(await collect(runtime().run(request(), {})))).toBe("ok");
    expect(logged().find((entry) => entry.unknownAnswer)?.unknownAnswer?.error).toBeDefined();
  });

  it("stops the agent when the run is cancelled", async () => {
    computer("hang");
    const controller = new AbortController();
    const run = request();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime().run(run, { signal: controller.signal })) {
      events.push(event);
      if (event.type === "text") controller.abort();
    }
    expect(events.some((event) => event.type === "done")).toBe(false);
    await vi.waitFor(() => expect(liveAgentRuns().has(run.runId)).toBe(false));
  });

  it.each([
    ["fail", "model went away"],
    ["limit-unknown", "Codex usage limit reached."],
    ["turn-failed", "Codex ended the turn (failed)."],
    ["turn-error", "bad things"],
    ["crash", "Codex stopped."],
    ["turn-missing", "Codex ended the turn (unknown)."],
    ["fail-silent", "Codex failed."],
    ["turn-refused", "Codex refused the turn."],
    ["dead-at-thread", "Codex"],
    ["bridge-fails", "Codex could not reach Dozo's tools."],
  ])("ends the run with what Codex said when its turn fails (%s)", async (scenario, message) => {
    computer(scenario);
    const run = request();
    await expect(collect(runtime().run(run, {}))).rejects.toThrow(message);
    expect(liveAgentRuns().has(run.runId)).toBe(false);
  });

  it.each([
    [
      "file-change",
      "Codex wants to change files.",
      "notes.md\nedit the notes",
      { decision: "decline" },
    ],
    ["elicit", "Codex asks to go on with a tool.", "Go on with lookup?", { action: "decline" }],
  ])(
    "asks the person before %s, and declines when they do",
    async (scenario, text, detail, answer) => {
      computer(scenario);
      const first = request();
      const asked = await collect(runtime().run(first, {}));
      expect(asked.at(-1)).toMatchObject({ type: "ask", text, detail });
      await collect(
        runtime().run(
          request({
            runId: first.runId,
            resumeToolResult: { content: [{ type: "text", text: DECLINE }] },
          }),
          {},
        ),
      );
      expect(logged().find((entry) => entry.decision)?.decision).toEqual(answer);
    },
  );

  it("refuses an agent that cannot start, leaving nothing behind", async () => {
    computer("signed-out");
    const run = request();
    await expect(collect(runtime().run(run, {}))).rejects.toThrow(CODEX_SIGNED_OUT_ERROR);
    expect(liveAgentRuns().has(run.runId)).toBe(false);
    await expect(collect(runtime().run(run, {}))).rejects.toThrow(CODEX_SIGNED_OUT_ERROR);
  });

  it("gives the agent a tool's plain result as text", async () => {
    computer("tool");
    const tools = [
      { name: "lookup", description: "Look up the weather.", inputSchema: { type: "object" } },
    ];
    const plain = await collect(
      runtime().run(request({ tools, executeTool: vi.fn(async () => "rain") }), {}),
    );
    expect(textOf(plain)).toBe("tool said rain");
    computer("tool");
    const shaped = await collect(
      runtime().run(request({ tools, executeTool: vi.fn(async () => ({ ok: true })) }), {}),
    );
    expect(textOf(shaped)).toBe('tool said {"ok":true}');
    computer("tool");
    const failing = await collect(
      runtime().run(
        request({
          tools,
          executeTool: vi.fn(async () => {
            throw new Error("tool broke");
          }),
        }),
        {},
      ),
    );
    expect(textOf(failing)).toBe("tool said tool broke");
  });

  it("refuses to read a turned-on list it cannot read", () => {
    const { data } = computer("reply");
    vi.stubEnv("DATA_DIR", join(data, "dozo-agent-tools"));
    expect(() => enabledAgentProviders()).toThrow();
  });

  it("gives a new process the conversation so far", () => {
    expect(agentInput(request())).toBe("Say hello");
    expect(
      agentInput(
        request({
          history: [
            { role: "user", content: "Hi", speaker: "Ada" },
            { role: "assistant", content: "Hello" },
            { role: "system", content: "hidden" },
          ],
        }),
      ),
    ).toBe("Earlier in this conversation:\nAda: Hi\n\nYou: Hello\n\nNow:\nSay hello");
  });
});

describe.skipIf(process.platform === "win32")("checking Codex when connecting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const check = async () => {
    const { data } = computer(currentScenario);
    return codexAgentDriver.selfTest(
      { home: process.env.HOST_USER_HOME!, path: process.env.HOST_USER_PATH! },
      data,
    );
  };
  let currentScenario = "reply";

  it.each([
    ["reply", undefined],
    ["old", "This Codex version has not been checked with Dozo yet; use Codex 0.171."],
    ["signed-out", CODEX_SIGNED_OUT_ERROR],
    ["bridge-fails", "Codex could not reach Dozo's tools."],
    ["garbled", "This Codex version has not been checked with Dozo yet; use Codex 0.171."],
    ["dead-at-thread", "Codex did not start its app server as expected."],
  ])("%s", async (scenario, reason) => {
    currentScenario = scenario;
    expect(await check()).toBe(reason);
  });

  it("says when Codex is not installed", async () => {
    const { data } = computer("reply");
    expect(await codexAgentDriver.installed({ home: data, path: "/nonexistent" })).toBe(false);
    expect(await codexAgentDriver.selfTest({ home: data, path: "/nonexistent" }, data)).toBe(
      "Codex is not installed on this computer.",
    );
  });

  it("keeps every server secret out of Codex's environment", () => {
    expect(codexEnv({ PATH: "/bin", ...SECRETS, CODEX_HOME: "/elsewhere" })).toEqual({
      PATH: "/bin",
    });
  });
});

describe("the bridge to Dozo's tools", () => {
  it("answers only a caller with this run's key, and only for the tools offered", async () => {
    const bridge = await startAgentBridge();
    let calls = 0;
    bridge.serve([{ name: "lookup", description: "d", inputSchema: {} }], async () => {
      calls += 1;
      if (calls > 1) throw "a plain failure";
      return { text: "ran", isError: false };
    });
    const talk = (lines: object[]) =>
      new Promise<string[]>((resolve) => {
        const socket = createConnection(bridge.launch.env.DOZO_BRIDGE_SOCKET!);
        const replies: string[] = [];
        socket.on("data", (chunk) => replies.push(...chunk.toString().trim().split("\n")));
        socket.on("close", () => resolve(replies));
        for (const line of lines) socket.write(`${JSON.stringify(line)}\n`);
        setTimeout(() => socket.end(), 200);
      });
    const key = bridge.launch.env.DOZO_BRIDGE_KEY;
    expect(await talk([{ id: 1, key: "0".repeat(64), method: "list" }])).toEqual([]);
    expect(await talk([{ id: 1, key: "not hex", method: "list" }])).toEqual([]);
    expect(
      await talk([{ id: 1, key: bridge.launch.env.DOZO_BRIDGE_KEY, method: "delete" }]),
    ).toEqual([]);
    expect(await talk(["not json" as unknown as object])).toEqual([]);
    const odd = (
      await talk([{ id: 4, key: bridge.launch.env.DOZO_BRIDGE_KEY, method: "call", name: 7 }])
    ).map((line) => JSON.parse(line));
    expect(odd[0]).toEqual({ id: 4, text: "There is no tool named .", isError: true });
    expect(await talk([{ id: 5, key: "x".repeat(4 * 1024 * 1024 + 1), method: "list" }])).toEqual(
      [],
    );
    const replies = (
      await talk([
        { id: 1, key, method: "list" },
        { id: 2, key, method: "call", name: "rm-rf", arguments: {} },
        { id: 3, key, method: "call", name: "lookup", arguments: [] },
      ])
    ).map((line) => JSON.parse(line));
    expect(replies[0].tools).toEqual([{ name: "lookup", description: "d", inputSchema: {} }]);
    expect(replies[1]).toEqual({ id: 2, text: "There is no tool named rm-rf.", isError: true });
    expect(replies[2]).toEqual({ id: 3, text: "ran", isError: false });
    expect(bridge.listed()).toBe(true);
    const failed = (
      await talk([
        { id: 6, key: bridge.launch.env.DOZO_BRIDGE_KEY, method: "call", name: "lookup" },
      ])
    ).map((line) => JSON.parse(line));
    expect(failed[0]).toEqual({ id: 6, text: "a plain failure", isError: true });
    await bridge.close();
    expect(existsSync(bridge.launch.env.DOZO_BRIDGE_SOCKET!)).toBe(false);
  });
});

describe("Codex's requests as approval cards", () => {
  it.each([
    [
      { method: "item/commandExecution/requestApproval", params: {} },
      { summary: "Codex wants to run a command." },
    ],
    [
      { method: "item/commandExecution/requestApproval", params: { command: "rm *x*", cwd: "/w" } },
      { summary: "Codex wants to run a command.", detail: "rm *x*\nin /w" },
    ],
    [
      { method: "item/fileChange/requestApproval", params: { grantRoot: "/w" } },
      { summary: "Codex wants to change files.", detail: "a.txt\nand anything under /w" },
    ],
    [
      { method: "item/fileChange/requestApproval", params: {} },
      { summary: "Codex wants to change files." },
    ],
    [
      {
        method: "item/permissions/requestApproval",
        params: { reason: "net", permissions: { network: {} } },
      },
      { summary: "Codex asks for more access.", detail: 'net\n{"network":{}}' },
    ],
    [
      { method: "item/permissions/requestApproval" },
      { summary: "Codex asks for more access.", detail: "{}" },
    ],
    [
      { method: "mcpServer/elicitation/request", params: {} },
      { summary: "Codex asks to go on with a tool." },
    ],
    [{ method: "item/tool/call", params: {} }, undefined],
  ])("%o", (message, card) => {
    const params = (message as { params?: { grantRoot?: string } }).params;
    const files = params?.grantRoot ? ["a.txt"] : [];
    expect(codexApproval(message, files)).toEqual(card);
  });

  it("answers once or not at all, never for the session", () => {
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ]) {
      expect(codexAnswer(method, {}, "accept")).toEqual({ decision: "accept" });
      expect(codexAnswer(method, {}, "decline")).toEqual({ decision: "decline" });
    }
    expect(codexAnswer("item/permissions/requestApproval", {}, "accept")).toEqual({
      permissions: {},
      scope: "turn",
    });
  });
});

describe("the agent runtime's own rules", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A driver whose one turn reports what the test gives it. */
  function stub(events: AgentSessionEvent[]): AgentDriver {
    const session: AgentSession = {
      turn: () => ({
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
      }),
      answer: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(),
    };
    return {
      provider: CODEX_AGENT_PROVIDER_ID,
      name: "Stub",
      command: "stub",
      modelSource: "openai-codex",
      installed: async () => true,
      selfTest: async () => undefined,
      start: async () => session,
    };
  }
  const run = (driver: AgentDriver, over: Partial<AgentRunRequest> = {}, waitLimitMs?: number) =>
    collect(
      withAgentRuntime(model, [driver], {
        accessCheck: async () => undefined,
        runAllowed: async () => undefined,
        ...(waitLimitMs ? { waitLimitMs } : {}),
      }).run(request(over), {}),
    );

  it("passes describe and abort to the model runtime", async () => {
    const runtimeOf = withAgentRuntime(model, [], {
      accessCheck: async () => undefined,
      runAllowed: async () => undefined,
    });
    runtimeOf.describe();
    await runtimeOf.abort("run-x");
    expect(model.abort).toHaveBeenCalledWith("run-x");
  });

  it("finishes a turn that says nothing", async () => {
    computer("reply");
    expect(await run(stub([]))).toEqual([{ type: "done" }]);
  });

  it("asks without a detail when the agent gives none, and lets a wait end on its own", async () => {
    computer("reply");
    const first = request();
    const events = await run(
      stub([{ type: "approval", id: "a", summary: "May I?" }]),
      { runId: first.runId },
      50,
    );
    expect(events.at(-1)).toMatchObject({ type: "ask", text: "May I?" });
    expect(events.at(-1)).not.toHaveProperty("detail");
    await vi.waitFor(() => expect(liveAgentRuns().has(first.runId)).toBe(false));
  });

  it("reads a secret's pause as a pause too, and every tool result as text", async () => {
    computer("tool");
    const tools = [
      { name: "lookup", description: "Look up the weather.", inputSchema: { type: "object" } },
    ];
    const secretPause = { kind: "agent_tool_result", content: [], details: { secret: "paused" } };
    const events = await collect(
      runtime().run(request({ tools, executeTool: vi.fn(async () => secretPause) }), {}),
    );
    expect(events.some((event) => event.type === "done")).toBe(false);
    for (const [result, said] of [
      [{ content: [{ type: "image" }, { type: "text", text: "a" }] }, "a"],
      [{ content: [{ type: "image" }] }, '{"content":[{"type":"image"}]}'],
      [null, "null"],
      [
        { kind: "other", details: { approval: "paused" } },
        '{"kind":"other","details":{"approval":"paused"}}',
      ],
    ] as const) {
      computer("tool");
      const text = textOf(
        await collect(
          runtime().run(request({ tools, executeTool: vi.fn(async () => result) }), {}),
        ),
      );
      expect(text).toBe(`tool said ${said}`);
    }
  });

  it("finds no agent-mode list in a server folder without one", () => {
    expect(
      enabledAgentProviders({ DATA_DIR: mkdtempSync(join(tmpdir(), "dozo-empty-")) }).size,
    ).toBe(0);
    expect(enabledAgentProviders({}).size).toBe(0);
  });
});

describe("who may start an agent run", () => {
  const prismaWith = (run: unknown, tokenText = false) =>
    ({
      run: { findUnique: async () => run },
      $queryRaw: async () => [{ sourced: tokenText }],
    }) as unknown as Parameters<typeof ownRun>[0];

  it("refuses a run that text sent with an access token reached", async () => {
    const run = { trigger: "user", userId: "ada", botId: "b", threadId: "t", sourceMessage: null };
    expect(await ownRun(prismaWith(run, true), "run-1")).toBe(AGENT_TOKEN_TEXT);
  });

  it.each([
    [{ trigger: "user", userId: "ada", sourceMessage: { authorUserId: "ada" } }, undefined],
    [{ trigger: "resume", userId: "ada", sourceMessage: null }, undefined],
    [{ trigger: "follow_up", userId: "ada", sourceMessage: { authorUserId: "ada" } }, undefined],
    [
      { trigger: "user", userId: "ada", sourceMessage: { authorUserId: "bob" } },
      AGENT_OWN_RUNS_ONLY,
    ],
    [{ trigger: "messaging", userId: "ada", sourceMessage: null }, AGENT_OWN_RUNS_ONLY],
    [{ trigger: "bot_message", userId: "ada", sourceMessage: null }, AGENT_OWN_RUNS_ONLY],
    [{ trigger: "webhook", userId: "ada", sourceMessage: null }, AGENT_OWN_RUNS_ONLY],
    [{ trigger: "routine", userId: "ada", sourceMessage: null }, AGENT_OWN_RUNS_ONLY],
    [null, AGENT_OWN_RUNS_ONLY],
  ])("%o", async (run, refusal) => {
    expect(await ownRun(prismaWith(run), "run-1")).toBe(refusal);
  });
});

describe.skipIf(process.platform === "win32")("the server's runtime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends an agent connection's run to agent mode, which asks who started it", async () => {
    computer("reply");
    const prisma = {
      user: { count: async () => 1 },
      run: {
        findUnique: async () => ({ trigger: "messaging", userId: "ada", sourceMessage: null }),
      },
    } as unknown as Parameters<typeof cliModelRuntime>[2]["prisma"];
    const serverRuntime = cliModelRuntime(
      { defaultProvider: "openrouter", defaultModel: "m", deploymentModelConfigured: false },
      model,
      { prisma, billingEnabled: false },
    );
    await expect(collect(serverRuntime.run(request(), {}))).rejects.toThrow(AGENT_OWN_RUNS_ONLY);
    expect(logged()).toEqual([]);
  });

  it("runs an agent whose mode the setting turned on, with no file", async () => {
    computer("reply", { enabled: false });
    const row = { current: false };
    const prisma = {
      user: { count: async () => 1 },
      $queryRaw: async () => (row.current ? [{ provider: CODEX_AGENT_PROVIDER_ID }] : []),
      run: {
        findUnique: async () => ({ trigger: "messaging", userId: "ada", sourceMessage: null }),
      },
    } as unknown as Parameters<typeof cliModelRuntime>[2]["prisma"];
    const serverRuntime = cliModelRuntime(
      { defaultProvider: "openrouter", defaultModel: "m", deploymentModelConfigured: false },
      model,
      { prisma, billingEnabled: false },
    );
    await expect(collect(serverRuntime.run(request(), {}))).rejects.toThrow(/not turned on/);
    // With the setting on, the run goes on to ask who started it, as with the file.
    row.current = true;
    await expect(collect(serverRuntime.run(request(), {}))).rejects.toThrow(AGENT_OWN_RUNS_ONLY);
  });
});
