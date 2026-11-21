import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_INTERRUPTED_ERROR,
  AGENT_OWN_MODEL,
  ALLOW_ONCE,
  DECLINE,
  liveAgentRuns,
  withAgentRuntime,
} from "../dozo-agent.js";
import { startAgentBridge } from "../dozo-agent-bridge.js";
import type { AcpAgentEntry } from "./dozo-acp-agent.js";
import {
  ACP_SIGNED_OUT,
  ACP_UNCHECKED,
  acpAgentDriver,
  acpApproval,
  acpOutcome,
} from "./dozo-acp-agent.js";
import { ACP_AGENTS } from "./dozo-acp-catalog.js";

const FAKE = fileURLToPath(new URL("./dozo-fake-acp-agent.test-support.mjs", import.meta.url));
const SECRETS = { DATABASE_URL: "postgres://u:fake@db.invalid/x", ENCRYPTION_KEY: "fake-key" };
const ANTIGRAVITY = ACP_AGENTS.find((entry) => entry.termsRisk)!;
const GROK = ACP_AGENTS.find((entry) => entry.authenticate)!;
let log: string;

type Logged = {
  started?: string[];
  env?: Record<string, string>;
  received?: { method?: string; params?: Record<string, unknown>; result?: unknown };
  outcome?: unknown;
  prompt?: string;
  mcpTools?: string[];
  fsAnswer?: { error?: unknown };
  otherOutcome?: unknown;
  earlyAnswer?: { error?: unknown };
  earlyPermission?: unknown;
};

/** The person's computer with a fake ACP agent named like `entry`'s command, turned on. */
function computer(scenario: string, entry: AcpAgentEntry = ANTIGRAVITY) {
  const home = mkdtempSync(join(tmpdir(), "dozo-person-home-"));
  const bin = mkdtempSync(join(tmpdir(), "dozo-person-bin-"));
  const data = mkdtempSync(join(tmpdir(), "dozo-server-data-"));
  log = join(bin, "calls.log");
  writeFileSync(
    join(bin, entry.command),
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "${scenario}" "${log}" "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(data, "dozo-agent-tools"), `${entry.provider}\n`);
  vi.stubEnv("HOST_USER_HOME", home);
  vi.stubEnv("HOST_USER_PATH", `${bin}:/usr/bin:/bin`);
  vi.stubEnv("DATA_DIR", data);
  return { home, bin, data, host: { home, path: `${bin}:/usr/bin:/bin` } };
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
  async *run() {},
};
const driver = acpAgentDriver(ANTIGRAVITY, { bridgeWaitMs: 300 });
const runtime = () =>
  withAgentRuntime(model, [driver], {
    accessCheck: async () => undefined,
    runAllowed: async () => undefined,
  });

function request(over: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    runId: `run-${Math.random().toString(16).slice(2)}`,
    prompt: "Say hello",
    instructions: "You are a helpful bot.",
    history: [],
    tools: [],
    model: { provider: ANTIGRAVITY.provider, id: AGENT_OWN_MODEL, apiKey: "dozo-cli-account:home" },
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
const resumed = (runId: string, answer: string) =>
  request({ runId, resumeToolResult: { content: [{ type: "text", text: answer }] } });

describe.skipIf(process.platform === "win32")("agent mode over ACP", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs a turn with no file or terminal methods offered, and no server secret", async () => {
    computer("reply");
    const events = await collect(runtime().run(request(), {}));
    expect(textOf(events)).toBe("Hello there");
    expect(events).toContainEqual({ type: "progress", text: "Reading notes" });
    expect(events.at(-1)).toEqual({ type: "done" });
    const [init] = sent("initialize");
    expect(init?.received?.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const [session] = sent("session/new");
    expect(session?.received?.params).toMatchObject({
      mcpServers: [{ name: "dozo", command: process.execPath }],
    });
    const servers = session?.received?.params?.mcpServers as { env: { name: string }[] }[];
    const env = servers[0]?.env ?? [];
    expect(env.map((entry) => entry.name)).toEqual(["DOZO_BRIDGE_SOCKET", "DOZO_BRIDGE_KEY"]);
    // The bot's instructions reach the agent once, with its first turn.
    expect(logged().find((entry) => entry.prompt)?.prompt).toBe(
      "Instructions:\nYou are a helpful bot.\n\nSay hello",
    );
    const started = logged().find((entry) => entry.started);
    expect(started?.started).toEqual(["acp"]);
    expect(started?.env?.DATABASE_URL).toBeUndefined();
    expect(started?.env?.ENCRYPTION_KEY).toBeUndefined();
    expect(sent("authenticate")).toEqual([]);
  });

  it("asks the person, and picks only the option that allows once", async () => {
    computer("permission");
    const first = request();
    const asked = await collect(runtime().run(first, {}));
    expect(asked.at(-1)).toEqual({
      type: "ask",
      text: "Antigravity asks before it goes on (execute).",
      detail: 'Run ls\n/w/a\n{"command":"ls"}',
      actions: [
        { id: "allow-once", label: ALLOW_ONCE },
        { id: "decline", label: DECLINE },
      ],
    });
    await collect(runtime().run(resumed(first.runId, ALLOW_ONCE), {}));
    expect(logged().find((entry) => entry.outcome)?.outcome).toEqual({
      outcome: "selected",
      optionId: "once",
    });
  });

  it("declines only this time, and cancels where there is no one-time option", async () => {
    computer("permission");
    const first = request();
    await collect(runtime().run(first, {}));
    await collect(runtime().run(resumed(first.runId, "Always allow"), {}));
    expect(logged().find((entry) => entry.outcome)?.outcome).toEqual({
      outcome: "selected",
      optionId: "no",
    });
    computer("permission-no-once");
    const second = request();
    await collect(runtime().run(second, {}));
    await collect(runtime().run(resumed(second.runId, ALLOW_ONCE), {}));
    expect(logged().find((entry) => entry.outcome)?.outcome).toEqual({ outcome: "cancelled" });
  });

  it("answers every waiting permission as cancelled when it stops the turn", async () => {
    const { host, data } = computer("cancel-pending");
    const bridge = await startAgentBridge();
    const session = await driver.start({
      host,
      cwd: data,
      model: AGENT_OWN_MODEL,
      instructions: "",
      bridge: bridge.launch,
    });
    const events = session.turn("go")[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ type: "approval" });
    await session.interrupt();
    expect((await events.next()).value).toEqual({
      type: "failed",
      message: "Antigravity stopped the turn.",
    });
    expect(sent("session/cancel")).toHaveLength(1);
    expect(logged().find((entry) => entry.outcome)?.outcome).toEqual({ outcome: "cancelled" });
    await session.answer("unknown", "accept");
    session.close();
    await bridge.close();
  });

  it("runs Dozo's tools through the run's executor, and goes on after a tool's approval", async () => {
    computer("tool");
    const tools = [{ name: "lookup", description: "Weather.", inputSchema: { type: "object" } }];
    const executeTool = vi.fn(async () => ({ content: [{ type: "text", text: "sunny" }] }));
    expect(textOf(await collect(runtime().run(request({ tools, executeTool }), {})))).toBe(
      "tool said sunny",
    );
    expect(executeTool).toHaveBeenCalledWith("lookup", { city: "Oslo" }, expect.any(String));
    computer("tool");
    const paused = { kind: "agent_tool_result", content: [], details: { approval: "paused" } };
    const first = request({ tools, executeTool: vi.fn(async () => paused) });
    const events = await collect(runtime().run(first, {}));
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(sent("session/cancel")).toHaveLength(1);
    const next = await collect(
      runtime().run(
        request({ runId: first.runId, tools, executeTool, prompt: "continue: ok" }),
        {},
      ),
    );
    expect(textOf(next)).toBe("after approval");
    expect(sent("session/new")).toHaveLength(1);
  });

  it("ends a run as interrupted when its process is gone, never starting it again", async () => {
    computer("permission");
    const first = request();
    await collect(runtime().run(first, {}));
    const kept = liveAgentRuns() as Map<string, { session: { close(): void } }>;
    kept.get(first.runId)?.session.close();
    kept.delete(first.runId);
    await expect(collect(runtime().run(resumed(first.runId, ALLOW_ONCE), {}))).rejects.toThrow(
      AGENT_INTERRUPTED_ERROR,
    );
    expect(sent("session/new")).toHaveLength(1);
  });

  it.each([
    ["signed-out", ACP_SIGNED_OUT("Antigravity")],
    ["refusal", "Antigravity refused to go on."],
    ["odd", "Antigravity ended the turn (something_new)."],
    ["error", "Quota exceeded for this account."],
    ["crash", "Antigravity stopped."],
    ["old", ACP_UNCHECKED("Antigravity")],
    ["session-broken", "internal"],
  ])("ends the run with what happened (%s)", async (scenario, message) => {
    computer(scenario);
    const run = request();
    await expect(collect(runtime().run(run, {}))).rejects.toThrow(message);
    expect(liveAgentRuns().has(run.runId)).toBe(false);
  });

  it("cancels a permission of another session, and the same request asked twice", async () => {
    computer("stray-permissions");
    const first = request();
    const asked = await collect(runtime().run(first, {}));
    expect(asked.at(-1)).toMatchObject({ type: "ask", detail: "a" });
    expect(logged().find((entry) => entry.otherOutcome)?.otherOutcome).toEqual({
      outcome: "cancelled",
    });
    // The second request with the same id is cancelled while the first waits for the person.
    await vi.waitFor(() => expect(logged().some((entry) => entry.outcome)).toBe(true));
    await collect(runtime().run(resumed(first.runId, ALLOW_ONCE), {}));
    const outcomes = logged().flatMap((entry) => (entry.outcome ? [entry.outcome] : []));
    expect(outcomes).toEqual([{ outcome: "cancelled" }, { outcome: "selected", optionId: "once" }]);
  });

  it("answers what the agent asks before any turn, never leaving it waiting", async () => {
    computer("early-request");
    expect(textOf(await collect(runtime().run(request(), {})))).toBe("");
    const early = logged().find((entry) => entry.earlyAnswer);
    expect(early?.earlyAnswer?.error).toBeDefined();
    expect(early?.earlyPermission).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("refuses a file or terminal request: it was not offered", async () => {
    computer("fs-request");
    expect(textOf(await collect(runtime().run(request(), {})))).toBe("ok");
    expect(logged().find((entry) => entry.fsAnswer)?.fsAnswer?.error).toBeDefined();
  });
});

describe.skipIf(process.platform === "win32")("checking an ACP agent when connecting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["reply", undefined],
    ["old", ACP_UNCHECKED("Antigravity")],
    ["v2", ACP_UNCHECKED("Antigravity")],
    ["signed-out", ACP_SIGNED_OUT("Antigravity")],
    ["bridge-silent", "Antigravity could not reach Dozo's tools."],
    ["dead", "Antigravity did not start as an ACP agent as expected."],
  ])("%s", async (scenario, reason) => {
    const { host, data } = computer(scenario);
    expect(await driver.selfTest(host, data)).toBe(reason);
  });

  it("says when the agent is not installed, without running anything", async () => {
    const { data } = computer("reply");
    const nowhere = { home: data, path: "/nonexistent" };
    expect(await driver.installed(nowhere)).toBe(false);
    expect(await driver.selfTest(nowhere, data)).toBe(
      "Antigravity is not installed on this computer.",
    );
    expect(await driver.installed({ home: data })).toBe(false);
  });

  it("refuses every Grok version until one has been checked", async () => {
    const { host, data } = computer("cached", GROK);
    expect(await acpAgentDriver(GROK).selfTest(host, data)).toBe(ACP_UNCHECKED("Grok"));
  });

  it("signs Grok in with its cached sign-in, never a key", async () => {
    const { host, data } = computer("cached", GROK);
    const checked = acpAgentDriver({ ...GROK, versions: { min: [1, 5, 0], below: [1, 6, 0] } });
    expect(await checked.selfTest(host, data)).toBeUndefined();
    expect(sent("authenticate")[0]?.received?.params).toEqual({
      methodId: "cached_token",
      _meta: { headless: true },
    });
    const plain = computer("reply", GROK);
    expect(await checked.selfTest(plain.host, plain.data)).toBeUndefined();
    expect(sent("authenticate")).toEqual([]);
  });

  it("marks only the agent whose maker's terms put the account at risk", () => {
    expect(driver.termsRisk).toBe(true);
    expect(acpAgentDriver(GROK).termsRisk).toBeUndefined();
  });
});

describe("ACP requests as approval cards", () => {
  it("shows what the agent says it will do, as plain text", () => {
    expect(acpApproval("X", {})).toEqual({ summary: "X asks before it goes on (other)." });
    expect(
      acpApproval("X", { toolCall: { title: 3, kind: "edit", locations: [{ path: 1 }, {}] } }),
    ).toEqual({ summary: "X asks before it goes on (edit)." });
  });

  it("never picks an option that allows or declines for good", () => {
    const always = [
      { optionId: "a", kind: "allow_always" },
      { optionId: "r", kind: "reject_always" },
    ];
    expect(acpOutcome({ options: always }, "accept")).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(acpOutcome({ options: always }, "decline")).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(acpOutcome({}, "accept")).toEqual({ outcome: { outcome: "cancelled" } });
    expect(acpOutcome({ options: [{ kind: "allow_once" }] }, "accept")).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });
});
