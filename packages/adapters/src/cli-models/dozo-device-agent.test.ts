import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { UserDeviceSummary } from "@rakazo/contracts";
import { withAbort } from "@rakazo/core";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred, flush } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { HostComputerRequest } from "../host-computer-protocol.js";
import { UserDeviceOfflineError } from "../user-device-gateway.js";
import {
  AGENT_BRIDGE_PAUSED,
  AGENT_INTERRUPTED_ERROR,
  AGENT_OWN_RUNS_ONLY,
  AGENT_RECONNECT_ERROR,
} from "./dozo-agent.js";
import { cliModelRuntime } from "./dozo-cli-runtime.js";
import type { DeviceAgentGateway } from "./dozo-device-agent.js";
import {
  DEVICE_APPROVAL_EXPIRED_TEXT,
  DEVICE_OFFLINE_ERROR,
  withDeviceAgentRuntime,
} from "./dozo-device-agent.js";

const AGENT = "antigravity-agent";
const REF = "dozo-cli-account:device:dev-1";

type Step = Record<string, unknown> | { wait: string } | { hang: true } | { fail: Error };

/** A paired computer that plays a script for each turn, and records everything it was sent. */
class Computer implements DeviceAgentGateway {
  readonly requests: Array<{
    userId: string;
    deviceId?: string;
    request: HostComputerRequest & Record<string, unknown>;
  }> = [];
  readonly cancelled: string[] = [];
  offline = false;
  /** Answers a tool result with this error, as a lost connection would. */
  failResult?: Error;
  /** How many stops are refused as offline before one is taken. */
  stopsRefused = 0;
  stopFailure?: Error;
  script: Step[] = [{ type: "started" }, { type: "done" }];
  private readonly results = new Map<string, Deferred>();
  /** The agent's session ended: a turn that waits is let go, as the app ends it on a stop. */
  private readonly stopped = deferred();

  private result(callId: string) {
    const held = this.results.get(callId) ?? deferred();
    this.results.set(callId, held);
    return held;
  }

  async *request<T>(
    userId: string,
    request: HostComputerRequest,
    signal: AbortSignal,
    deviceId?: string,
  ): AsyncIterable<T> {
    const sent = request as HostComputerRequest & Record<string, unknown>;
    this.requests.push({ userId, deviceId, request: sent });
    if (this.offline) throw new UserDeviceOfflineError();
    if (sent.method === "agentToolResult" && this.failResult) throw this.failResult;
    if (sent.method === "agentStop" && this.stopsRefused-- > 0)
      throw this.stopFailure ?? new UserDeviceOfflineError();
    if (sent.method === "agentToolResult") this.result(String(sent.callId)).resolve();
    if (sent.method === "agentStop") this.stopped.resolve();
    if (sent.method !== "agentTurn") return;
    signal.addEventListener("abort", () => this.cancelled.push(String(sent.runId)), { once: true });
    for (const step of this.script) {
      if ("wait" in step) await withAbort(this.result(String(step.wait)).promise, signal);
      else if ("hang" in step) await withAbort(this.stopped.promise, signal);
      else if ("fail" in step) throw step.fail;
      else yield step as T;
    }
  }

  sent(method: string) {
    return this.requests.filter((entry) => entry.request.method === method);
  }
}

type RunRow = { trigger: string; userId: string; sourceMessage: { authorUserId: string } | null };

/** The rows a run is checked against: runs, connections and what each computer declared. */
function database(
  over: {
    runs?: Record<string, RunRow>;
    declared?: string[];
    credentialOwner?: string;
    /** What the person's paired computers look like in the database. */
    devices?: UserDeviceSummary[];
  } = {},
) {
  const devices = over.devices ?? [{ deviceId: "dev-1", name: "Laptop", connected: true }];
  const runs = over.runs ?? {
    "run-1": { trigger: "user", userId: "ada", sourceMessage: { authorUserId: "ada" } },
  };
  const declared = over.declared ?? [`agent:${AGENT}`, "shell"];
  return {
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => runs[where.id] ?? null,
    },
    userModelCredential: {
      findFirst: async ({ where }: { where: { userId: string } }) =>
        where.userId === (over.credentialOwner ?? "ada") ? { id: "conn-1" } : null,
    },
    userDevice: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        where.userId === "ada"
          ? devices.map((device) => ({
              id: device.deviceId,
              name: device.name,
              connections: device.connected ? [{ deviceId: device.deviceId }] : [],
            }))
          : [],
    },
    $queryRaw: async (strings: TemplateStringsArray) =>
      strings.join("?").includes("dozo_device_capabilities")
        ? [{ capabilities: declared }]
        : [{ sourced: false }],
  } as unknown as PrismaClient;
}

const model = (
  run: AgentRuntime["run"] = async function* () {
    yield { type: "text", text: "from the model" };
  },
) =>
  ({
    describe: () => ({}) as ReturnType<AgentRuntime["describe"]>,
    abort: vi.fn(async () => undefined),
    run: vi.fn(run),
  }) satisfies AgentRuntime;

const env = { defaultProvider: "openrouter", defaultModel: "m", deploymentModelConfigured: false };

function runtimeOn(computer: Computer, prisma = database(), next = model()) {
  // The server's own runtime: ownRun is the check the local path uses too.
  return { next, runtime: cliModelRuntime(env, next, { prisma, userDevices: computer }) };
}

const tool = (name: string) => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object" },
  readOnly: true,
  route: { kind: "internal" },
});

function request(over: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    botId: "bot-1",
    threadId: "thread-1",
    runId: "run-1",
    prompt: "Say hello",
    instructions: "You are a helpful bot.",
    history: [],
    tools: [],
    model: { provider: AGENT, id: "default", apiKey: REF, connectionId: "conn-1" },
    ...over,
  } as unknown as AgentRunRequest;
}

async function collect(stream: AsyncIterable<AgentRuntimeEvent>) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("an agent turn on the person's own computer", () => {
  it("streams the turn and ends the agent's session once it is done", async () => {
    const computer = new Computer();
    computer.script = [
      { type: "started" },
      { type: "text", text: "Hel" },
      { type: "activity", text: "Reading notes" },
      { type: "approvalWaiting", summary: "Run a command" },
      { type: "text", text: "lo" },
      { type: "done" },
    ];
    const { runtime, next } = runtimeOn(computer);
    expect(await collect(runtime.run(request(), {}))).toEqual([
      { type: "text", text: "Hel" },
      { type: "progress", text: "Reading notes" },
      { type: "progress", text: "Run a command" },
      { type: "text", text: "lo" },
      { type: "done" },
    ]);
    expect(next.run).not.toHaveBeenCalled();
    // Always that person's own, pinned computer.
    expect(computer.requests.map((entry) => [entry.userId, entry.deviceId])).toEqual([
      ["ada", "dev-1"],
      ["ada", "dev-1"],
    ]);
    expect(computer.sent("agentStop")).toHaveLength(1);
  });

  it("sends the parsed request: nothing the schema does not name reaches the computer", async () => {
    const computer = new Computer();
    const { runtime } = runtimeOn(computer);
    await collect(
      runtime.run(
        request({
          tools: [tool("lookup"), tool("bad name!")] as unknown as AgentRunRequest["tools"],
          executeTool: async () => "",
        }),
        {},
      ),
    );
    expect(computer.sent("agentTurn")[0]?.request).toEqual({
      method: "agentTurn",
      runId: "run-1",
      botId: "bot-1",
      agent: AGENT,
      instructions: "You are a helpful bot.",
      input: "Say hello",
      tools: [{ name: "lookup", description: "lookup tool", inputSchema: { type: "object" } }],
    });
  });

  it("names a model the agent takes as a protocol field only", async () => {
    const computer = new Computer();
    const { runtime } = runtimeOn(computer);
    await collect(
      runtime.run(request({ model: { provider: AGENT, id: "gem-1", apiKey: REF } as never }), {}),
    );
    expect(computer.sent("agentTurn")[0]?.request.model).toBe("gem-1");
  });

  it("refuses a conversation the computer would not take", async () => {
    const computer = new Computer();
    const { runtime } = runtimeOn(computer);
    await expect(
      collect(runtime.run(request({ prompt: "x".repeat(3 * 1024 * 1024) }), {})),
    ).rejects.toThrow("too large");
    expect(computer.requests).toEqual([]);
  });

  it("runs the bot's tool through the run's executor and answers the agent with its result", async () => {
    const computer = new Computer();
    computer.script = [
      { type: "started" },
      { type: "toolCall", callId: "c1", name: "lookup", args: { q: "tea" } },
      { wait: "c1" },
      { type: "done" },
    ];
    const executeTool = vi.fn(async () => ({ content: [{ type: "text", text: "found tea" }] }));
    const { runtime } = runtimeOn(computer);
    await collect(
      runtime.run(
        request({ tools: [tool("lookup")] as unknown as AgentRunRequest["tools"], executeTool }),
        {},
      ),
    );
    expect(executeTool).toHaveBeenCalledWith("lookup", { q: "tea" }, "run-1:c1");
    expect(computer.sent("agentToolResult")[0]?.request).toEqual({
      method: "agentToolResult",
      runId: "run-1",
      botId: "bot-1",
      callId: "c1",
      text: "found tea",
      isError: false,
    });
  });

  it("does not run a tool the turn did not list, and tells the agent it failed", async () => {
    const computer = new Computer();
    computer.script = [
      { type: "started" },
      { type: "toolCall", callId: "c1", name: "send_money", args: {} },
      { wait: "c1" },
      { type: "done" },
    ];
    const executeTool = vi.fn(async () => "never");
    const { runtime } = runtimeOn(computer);
    await collect(
      runtime.run(
        request({ tools: [tool("lookup")] as unknown as AgentRunRequest["tools"], executeTool }),
        {},
      ),
    );
    expect(executeTool).not.toHaveBeenCalled();
    expect(computer.sent("agentToolResult")[0]?.request).toMatchObject({
      callId: "c1",
      isError: true,
    });
  });

  it("pauses at a tool that waits for the person, and goes on in a new turn with their answer", async () => {
    const computer = new Computer();
    computer.script = [
      { type: "started" },
      { type: "toolCall", callId: "c1", name: "lookup", args: {} },
      { wait: "never-sent" },
      { type: "done" },
    ];
    const executeTool = vi.fn(async () => ({
      kind: "agent_tool_result",
      details: { approval: "paused" },
      content: [],
    }));
    const { runtime } = runtimeOn(computer);
    const events = await collect(
      runtime.run(
        request({ tools: [tool("lookup")] as unknown as AgentRunRequest["tools"], executeTool }),
        {},
      ),
    );
    // The attempt ends without finishing the run, and the agent's session stays open.
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(computer.sent("agentToolResult")[0]?.request).toMatchObject({
      text: AGENT_BRIDGE_PAUSED,
      isError: false,
    });
    expect(computer.sent("agentStop")).toEqual([]);
    expect(computer.cancelled).toEqual(["run-1"]);

    const again = new Computer();
    const resumed = database({
      runs: { "run-1": { trigger: "resume", userId: "ada", sourceMessage: null } },
    });
    const second = runtimeOn(again, resumed).runtime;
    await collect(
      second.run(
        request({
          prompt: "Yes, go ahead",
          history: [{ role: "user", content: "earlier" }] as never,
        }),
        {},
      ),
    );
    expect(again.sent("agentTurn")[0]?.request).toMatchObject({
      runId: "run-1",
      input: "Yes, go ahead",
    });
  });

  it("shows when nobody answered on the computer in time", async () => {
    const computer = new Computer();
    computer.script = [
      { type: "started" },
      { type: "text", text: "Working." },
      { type: "approvalExpired", summary: "Run a command" },
      { type: "done" },
    ];
    const { runtime } = runtimeOn(computer);
    const events = await collect(runtime.run(request(), {}));
    expect(events).toContainEqual({
      type: "text",
      text: `\n\n${DEVICE_APPROVAL_EXPIRED_TEXT}`,
    });
    expect(DEVICE_APPROVAL_EXPIRED_TEXT).toBe("Approval was pending on your computer.");
  });

  it("ends a run whose account ran out in the words the model pool reads", async () => {
    const computer = new Computer();
    computer.script = [{ type: "started" }, { type: "limit", resetsAt: Date.now() + 30 * 60_000 }];
    const { runtime } = runtimeOn(computer);
    await expect(collect(runtime.run(request(), {}))).rejects.toThrow(
      /Usage limit reached; try again in ~(29|30) min\./,
    );
    expect(computer.sent("agentStop")).toHaveLength(1);
  });

  it("ends the run with the reason the agent failed", async () => {
    const computer = new Computer();
    computer.script = [
      { type: "started" },
      { type: "failed", message: "Antigravity is signed out" },
    ];
    const { runtime } = runtimeOn(computer);
    await expect(collect(runtime.run(request(), {}))).rejects.toThrow("Antigravity is signed out");
  });

  it("ends the turn on a frame that is not in the protocol", async () => {
    const computer = new Computer();
    computer.script = [{ type: "started" }, { type: "text", text: "a", extra: true }];
    const { runtime } = runtimeOn(computer);
    await expect(collect(runtime.run(request(), {}))).rejects.toThrow("invalid response");
    expect(computer.sent("agentStop")).toHaveLength(1);
  });

  it("ends the turn as interrupted when the connection is lost, whenever it is, and never falls back", async () => {
    const lost = new Error("Your computer disconnected. Check the result before retrying.");
    for (const script of [[{ fail: lost }], [{ type: "started" }, { fail: lost }]]) {
      const computer = new Computer();
      computer.script = script;
      const { runtime, next } = runtimeOn(computer);
      await expect(
        collect(
          runtime.run(
            request({ fallbackModels: [{ provider: "openrouter", id: "m" }] } as never),
            {},
          ),
        ),
      ).rejects.toThrow(AGENT_INTERRUPTED_ERROR);
      expect(next.run).not.toHaveBeenCalled();
    }
  });

  it("stops the agent when the run is cancelled", async () => {
    const computer = new Computer();
    computer.script = [{ type: "started" }, { hang: true }];
    const { runtime } = runtimeOn(computer);
    const controller = new AbortController();
    const running = collect(runtime.run(request(), { signal: controller.signal }));
    await vi.waitFor(() => expect(computer.sent("agentTurn")).toHaveLength(1));
    await flush();
    controller.abort();
    await running;
    expect(computer.sent("agentStop")).toHaveLength(1);
  });

  it("stops a turn that is running when the runtime is told to abort the run", async () => {
    const computer = new Computer();
    computer.script = [{ type: "started" }, { hang: true }];
    const { runtime, next } = runtimeOn(computer);
    const running = collect(runtime.run(request(), {}));
    await vi.waitFor(() => expect(computer.sent("agentTurn")).toHaveLength(1));
    await runtime.abort("run-1");
    // The attempt ends quietly, without a second stop and without a result.
    expect(await running).toEqual([]);
    expect(computer.sent("agentStop")).toHaveLength(1);
    expect(next.abort).toHaveBeenCalledWith("run-1");
  });

  it("runs a call id once: a second call with it is not run and is answered as an error", async () => {
    const computer = new Computer();
    computer.script = [
      { type: "started" },
      { type: "toolCall", callId: "c1", name: "lookup", args: {} },
      { wait: "c1" },
      { type: "toolCall", callId: "c1", name: "lookup", args: {} },
      { type: "done" },
    ];
    const executeTool = vi.fn(async () => "ok");
    const { runtime } = runtimeOn(computer);
    await collect(
      runtime.run(
        request({ tools: [tool("lookup")] as unknown as AgentRunRequest["tools"], executeTool }),
        {},
      ),
    );
    expect(executeTool).toHaveBeenCalledTimes(1);
    const results = computer.sent("agentToolResult").map((entry) => entry.request.isError);
    expect(results).toEqual([false, true]);
  });

  it.each([
    [
      "a lost connection",
      new Error("Your computer disconnected. Check the result before retrying."),
    ],
    ["the turn's own time limit", new DOMException("timed out", "TimeoutError")],
  ])(
    "ends the run as interrupted, without a second send or a backup, on %s while a tool result is sent",
    async (_name, failure) => {
      const computer = new Computer();
      computer.failResult = failure;
      computer.script = [
        { type: "started" },
        { type: "toolCall", callId: "c1", name: "lookup", args: {} },
        { wait: "never" },
      ];
      const { runtime, next } = runtimeOn(computer);
      await expect(
        collect(
          runtime.run(
            request({
              tools: [tool("lookup")] as unknown as AgentRunRequest["tools"],
              executeTool: async () => "ok",
              fallbackModels: [{ provider: "openrouter", id: "m" }],
            } as never),
            {},
          ),
        ),
      ).rejects.toThrow(AGENT_INTERRUPTED_ERROR);
      expect(computer.sent("agentToolResult")).toHaveLength(1);
      expect(next.run).not.toHaveBeenCalled();
    },
  );

  it("tries a stop again on a lost connection, and gives up after three", async () => {
    const computer = new Computer();
    computer.stopsRefused = 2;
    const { runtime } = runtimeOn(computer);
    await collect(runtime.run(request(), {}));
    expect(computer.sent("agentStop")).toHaveLength(3);
  });

  it("tells a size the computer would not take from a fault of the server's own", async () => {
    const computer = new Computer();
    const { runtime } = runtimeOn(computer);
    for (const over of [
      { instructions: "x".repeat(600 * 1024) },
      { prompt: "x".repeat(3 * 1024 * 1024) },
    ])
      await expect(collect(runtime.run(request(over), {}))).rejects.toThrow(
        "This conversation is too large to send to your computer.",
      );
    const fault = await collect(runtime.run(request({ botId: "b".repeat(300) }), {})).catch(
      (error: Error) => error,
    );
    expect((fault as Error).message).toMatch(/^Agent turn request refused: botId/);
    expect(computer.requests).toEqual([]);
  });

  const calling = (computer: Computer, wait = "never") => {
    computer.script = [
      { type: "started" },
      { type: "toolCall", callId: "c1", name: "lookup", args: {} },
      { wait },
      { type: "done" },
    ];
    return { tools: [tool("lookup")] as unknown as AgentRunRequest["tools"] };
  };

  it("cuts a tool result the computer would not take, with a note", async () => {
    const computer = new Computer();
    computer.script = [
      { type: "started" },
      { type: "toolCall", callId: "c1", name: "lookup", args: {} },
      { wait: "c1" },
      { type: "done" },
    ];
    const { runtime } = runtimeOn(computer);
    await collect(
      runtime.run(
        request({
          ...calling(computer, "c1"),
          executeTool: async () => "x".repeat(2 * 1024 * 1024),
        }),
        {},
      ),
    );
    const sent = String(computer.sent("agentToolResult")[0]?.request.text);
    expect(sent.length).toBeLessThanOrEqual(1024 * 1024);
    expect(sent).toMatch(/\[result cut: too long\]$/);
  });

  it("tries a stop again after a dropped connection, and not after any other failure", async () => {
    const dropped = new Computer();
    dropped.stopsRefused = 1;
    dropped.stopFailure = new Error(
      "Your computer disconnected. Check the result before retrying.",
    );
    await collect(runtimeOn(dropped).runtime.run(request(), {}));
    expect(dropped.sent("agentStop")).toHaveLength(2);
    const other = new Computer();
    other.stopsRefused = 1;
    other.stopFailure = new Error("refused");
    await collect(runtimeOn(other).runtime.run(request(), {}));
    expect(other.sent("agentStop")).toHaveLength(1);
  });

  it("falls to a backup as it was listed when the run has no way to resolve it", async () => {
    const computer = new Computer();
    const { runtime, next } = runtimeOn(
      computer,
      database({ devices: [{ deviceId: "dev-1", name: "Laptop", connected: false }] }),
    );
    await collect(
      runtime.run(request({ fallbackModels: [{ provider: "openrouter", id: "m" }] } as never), {}),
    );
    expect(vi.mocked(next.run).mock.calls[0]![0].model).toEqual({
      provider: "openrouter",
      id: "m",
    });
  });

  it("ends quietly when the run was already cancelled before the turn started", async () => {
    const computer = new Computer();
    computer.script = [{ type: "started" }, { hang: true }];
    const controller = new AbortController();
    controller.abort();
    const { runtime } = runtimeOn(computer);
    expect(await collect(runtime.run(request(), { signal: controller.signal }))).toEqual([]);
  });

  it("shows the expired approval without a gap when nothing was said before", async () => {
    const computer = new Computer();
    computer.script = [
      { type: "started" },
      { type: "approvalExpired", summary: "x" },
      { type: "done" },
    ];
    const events = await collect(runtimeOn(computer).runtime.run(request(), {}));
    expect(events[0]).toEqual({ type: "text", text: DEVICE_APPROVAL_EXPIRED_TEXT });
  });

  it("ends quietly when the run is cancelled while a tool result is sent, and when the computer is gone", async () => {
    const cancelled = new Computer();
    cancelled.failResult = new Error("broken");
    const controller = new AbortController();
    const executeTool = async () => {
      controller.abort();
      return "ok";
    };
    expect(
      await collect(
        runtimeOn(cancelled).runtime.run(request({ ...calling(cancelled), executeTool }), {
          signal: controller.signal,
        }),
      ),
    ).toEqual([]);
    const gone = new Computer();
    gone.failResult = new UserDeviceOfflineError();
    await expect(
      collect(
        runtimeOn(gone).runtime.run(
          request({ ...calling(gone), executeTool: async () => "ok" }),
          {},
        ),
      ),
    ).rejects.toThrow(AGENT_INTERRUPTED_ERROR);
    const other = new Computer();
    other.failResult = new Error("something else");
    await expect(
      collect(
        runtimeOn(other).runtime.run(
          request({ ...calling(other), executeTool: async () => "ok" }),
          {},
        ),
      ),
    ).rejects.toThrow("something else");
  });

  it("passes on a tool's failure when the run was cancelled, and words one that is not an error", async () => {
    const computer = new Computer();
    const controller = new AbortController();
    await expect(
      collect(
        runtimeOn(computer).runtime.run(
          request({
            ...calling(computer),
            executeTool: async () => {
              controller.abort();
              throw new Error("stopped");
            },
          }),
          { signal: controller.signal },
        ),
      ),
    ).rejects.toThrow("stopped");
    const odd = new Computer();
    odd.script = [
      { type: "started" },
      { type: "toolCall", callId: "c1", name: "lookup", args: {} },
      { wait: "c1" },
      { type: "done" },
    ];
    await collect(
      runtimeOn(odd).runtime.run(
        request({
          ...calling(odd, "c1"),
          executeTool: async () => {
            throw "boom";
          },
        }),
        {},
      ),
    );
    expect(odd.sent("agentToolResult")[0]?.request).toMatchObject({
      text: "The tool failed.",
      isError: true,
    });
  });

  it("tells the agent when one of the bot's tools fails, and goes on", async () => {
    const computer = new Computer();
    computer.script = [
      { type: "started" },
      { type: "toolCall", callId: "c1", name: "lookup", args: {} },
      { wait: "c1" },
      { type: "done" },
    ];
    const executeTool = vi.fn(async () => {
      throw new Error("The lookup service is down");
    });
    const { runtime } = runtimeOn(computer);
    const events = await collect(
      runtime.run(
        request({ tools: [tool("lookup")] as unknown as AgentRunRequest["tools"], executeTool }),
        {},
      ),
    );
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(computer.sent("agentToolResult")[0]?.request).toMatchObject({
      text: "The lookup service is down",
      isError: true,
    });
  });

  it("ends the run as interrupted when the stream ends without the agent finishing", async () => {
    const computer = new Computer();
    computer.script = [{ type: "started" }, { type: "text", text: "Part" }];
    const { runtime } = runtimeOn(computer);
    await expect(collect(runtime.run(request(), {}))).rejects.toThrow(AGENT_INTERRUPTED_ERROR);
  });

  it("passes on a failure that is not the computer's being offline", async () => {
    const computer = new Computer();
    computer.script = [{ fail: new Error("Request to your computer is too large") }];
    const { runtime, next } = runtimeOn(computer);
    await expect(
      collect(runtime.run(request({ fallbackModels: [{ provider: "x", id: "y" }] } as never), {})),
    ).rejects.toThrow("too large");
    expect(next.run).not.toHaveBeenCalled();
  });

  it("leaves a model's run to the model runtime", async () => {
    const computer = new Computer();
    const { runtime, next } = runtimeOn(computer);
    const events = await collect(
      runtime.run(request({ model: { provider: "openrouter", id: "m" } as never }), {}),
    );
    expect(events).toEqual([{ type: "text", text: "from the model" }]);
    expect(next.run).toHaveBeenCalledTimes(1);
    expect(computer.requests).toEqual([]);
  });
});

describe("a computer that is offline before the turn starts", () => {
  const backups = [
    { provider: AGENT, id: "default" },
    { provider: "openrouter", id: "first", connectionId: "c-first" },
    { provider: "openrouter", id: "second" },
  ];
  const resolveFallbackModel = vi.fn(async (provider: string, id: string) => ({
    provider,
    id,
    apiKey: "backup-key",
  }));

  it("falls to the first backup that is not an agent, and says the run moved", async () => {
    const computer = new Computer();
    const onModelChange = vi.fn(async () => undefined);
    const { runtime, next } = runtimeOn(
      computer,
      database({ devices: [{ deviceId: "dev-1", name: "Laptop", connected: false }] }),
    );
    const events = await collect(
      runtime.run(
        request({ fallbackModels: backups, resolveFallbackModel, onModelChange } as never),
        {},
      ),
    );
    expect(events).toEqual([{ type: "text", text: "from the model" }]);
    expect(resolveFallbackModel).toHaveBeenCalledWith("openrouter", "first", "c-first");
    expect(onModelChange).toHaveBeenCalledWith("openrouter", "first");
    const asked = vi.mocked(next.run).mock.calls[0]![0];
    expect(asked.model).toEqual({ provider: "openrouter", id: "first", apiKey: "backup-key" });
    // What is left for it to fall back to afterwards: no agent among them.
    expect(asked.fallbackModels).toEqual([{ provider: "openrouter", id: "second" }]);
  });

  it("falls back too when the list says it is connected but the connection is gone", async () => {
    const computer = new Computer();
    computer.offline = true;
    const { runtime, next } = runtimeOn(computer);
    await collect(
      runtime.run(request({ fallbackModels: backups, resolveFallbackModel } as never), {}),
    );
    expect(next.run).toHaveBeenCalledTimes(1);
  });

  it("says it is offline when no backup was chosen", async () => {
    const computer = new Computer();
    const { runtime, next } = runtimeOn(
      computer,
      database({ devices: [{ deviceId: "dev-1", name: "Laptop", connected: false }] }),
    );
    await expect(collect(runtime.run(request(), {}))).rejects.toThrow(DEVICE_OFFLINE_ERROR);
    await expect(
      collect(
        runtime.run(request({ fallbackModels: [{ provider: AGENT, id: "default" }] } as never), {}),
      ),
    ).rejects.toThrow(DEVICE_OFFLINE_ERROR);
    expect(DEVICE_OFFLINE_ERROR).toBe("Your computer is offline.");
    expect(next.run).not.toHaveBeenCalled();
    expect(computer.sent("agentTurn")).toEqual([]);
  });

  it("sends no turn to a connected computer that does not say it runs the agent", async () => {
    const computer = new Computer();
    const { runtime } = runtimeOn(computer, database({ declared: ["shell", "screen"] }));
    await expect(collect(runtime.run(request(), {}))).rejects.toThrow(DEVICE_OFFLINE_ERROR);
    expect(computer.requests).toEqual([]);
  });

  it("never falls back once the agent said it started", async () => {
    const computer = new Computer();
    computer.script = [
      { type: "started" },
      { type: "text", text: "Part" },
      { fail: new Error("Your computer disconnected. Check the result before retrying.") },
    ];
    const { runtime, next } = runtimeOn(computer);
    await expect(
      collect(runtime.run(request({ fallbackModels: backups, resolveFallbackModel } as never), {})),
    ).rejects.toThrow(AGENT_INTERRUPTED_ERROR);
    expect(next.run).not.toHaveBeenCalled();
  });
});

describe("whose computer an agent turn may use", () => {
  it("refuses a run the person did not start, before anything reaches the computer", async () => {
    const computer = new Computer();
    const prisma = database({
      runs: { "run-1": { trigger: "webhook", userId: "ada", sourceMessage: null } },
    });
    const { runtime, next } = runtimeOn(computer, prisma);
    await expect(
      collect(runtime.run(request({ fallbackModels: [{ provider: "x", id: "y" }] } as never), {})),
    ).rejects.toThrow(AGENT_OWN_RUNS_ONLY);
    expect(computer.requests).toEqual([]);
    expect(next.run).not.toHaveBeenCalled();
  });

  it.each(["messaging", "bot_message", "routine", "group"])("refuses a %s run", async (trigger) => {
    const computer = new Computer();
    const prisma = database({
      runs: { "run-1": { trigger, userId: "ada", sourceMessage: null } },
    });
    await expect(collect(runtimeOn(computer, prisma).runtime.run(request(), {}))).rejects.toThrow(
      AGENT_OWN_RUNS_ONLY,
    );
    expect(computer.requests).toEqual([]);
  });

  it("never sends another member's run to this person's computer", async () => {
    const computer = new Computer();
    // Bob's own run in a shared Space, on a model resolved from Ada's connection.
    const prisma = database({
      runs: { "run-1": { trigger: "user", userId: "bob", sourceMessage: { authorUserId: "bob" } } },
      credentialOwner: "ada",
    });
    await expect(collect(runtimeOn(computer, prisma).runtime.run(request(), {}))).rejects.toThrow(
      AGENT_RECONNECT_ERROR,
    );
    expect(computer.requests).toEqual([]);
  });

  it("never reaches a computer that is not the run owner's, even with the connection's own name", async () => {
    const computer = new Computer();
    const { runtime } = runtimeOn(computer, database({ devices: [] }));
    await expect(collect(runtime.run(request(), {}))).rejects.toThrow(AGENT_RECONNECT_ERROR);
    expect(computer.requests).toEqual([]);
  });

  it.each([
    ["the person's own sign-in on a server", "dozo-cli-account:home"],
    ["a stored key", "sk-not-a-reference"],
    ["nothing", undefined],
  ])("refuses a connection that is %s", async (_name, apiKey) => {
    const computer = new Computer();
    const { runtime } = runtimeOn(computer);
    await expect(
      collect(
        runtime.run(request({ model: { provider: AGENT, id: "default", apiKey } as never }), {}),
      ),
    ).rejects.toThrow(AGENT_RECONNECT_ERROR);
    expect(computer.requests).toEqual([]);
  });

  it("refuses a run that no longer exists", async () => {
    const computer = new Computer();
    const prisma = database({ runs: {} });
    const runtime = withDeviceAgentRuntime(model(), {
      prisma,
      userDevices: computer,
      runAllowed: async () => undefined,
    });
    await expect(collect(runtime.run(request(), {}))).rejects.toThrow(AGENT_RECONNECT_ERROR);
    expect(computer.requests).toEqual([]);
  });

  it("refuses when the server has no way to reach computers", async () => {
    const hosted = cliModelRuntime(env, model(), { prisma: database() });
    await expect(collect(hosted.run(request(), {}))).rejects.toThrow(AGENT_RECONNECT_ERROR);
  });
});
