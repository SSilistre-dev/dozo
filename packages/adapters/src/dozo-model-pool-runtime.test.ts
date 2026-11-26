import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree only: the brand rules in pi-runtime-fallback.ts hand a failed call to
// the pool (dozo-model-pool.ts). A fake provider answers every call; nothing leaves the process.

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
  delay: vi.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>(),
}));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  abortableDelay: providerState.delay,
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));

vi.mock("./runtime/pi/models/pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./runtime/pi/models/pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import type { RunModelPool } from "./dozo-model-pool.js";
import { withRunModelPool } from "./dozo-model-pool.js";
import { OAUTH_RECONNECT_REQUIRED_ERROR } from "./runtime/pi/models/pi-oauth.js";
import { PiAgentRuntime } from "./runtime/pi/pi-runtime.js";

const pooled: Model<"openai-completions"> = {
  provider: "provider-a",
  id: "model-1",
  name: "model-1",
  api: "openai-completions",
  baseUrl: "https://models.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 4_096,
};
const other: Model<"openai-completions"> = { ...pooled, provider: "provider-z", id: "model-z" };

function reply(content: AssistantMessage["content"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: pooled.api,
    provider: pooled.provider,
    model: pooled.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: errorMessage ? "error" : "stop",
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function stream(response: AssistantMessage, shownFirst?: string) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [], stopReason: "stop" } });
  if (shownFirst) {
    const partial = { ...response, content: [{ type: "text" as const, text: shownFirst }] };
    result.push({ type: "text_start", contentIndex: 0, partial });
    result.push({ type: "text_delta", contentIndex: 0, delta: shownFirst, partial });
  }
  if (response.stopReason === "error") {
    result.push({ type: "error", reason: "error", error: response });
  } else {
    result.push({ type: "done", reason: "stop", message: response });
  }
  result.end(response);
  return result;
}

/** Answers by the key each call carries: a failure for `failing`, an answer for every other. */
function answer(failing: Record<string, string>, shownFirst?: string) {
  providerState.stream.mockImplementation(
    (_target: unknown, _context: unknown, options: { apiKey?: string }) => {
      const failure = options.apiKey ? failing[options.apiKey] : undefined;
      return failure
        ? stream(reply(shownFirst ? [{ type: "text", text: shownFirst }] : [], failure), shownFirst)
        : stream(reply([{ type: "text", text: `answered with ${options.apiKey}` }]));
    },
  );
}

const keysUsed = () =>
  providerState.stream.mock.calls.map(([, , options]) => (options as { apiKey?: string }).apiKey);

function request(withUserBackup = false): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Write the requested result",
    instructions: "",
    history: [],
    tools: [],
    model: { provider: pooled.provider, id: pooled.id, apiKey: "key-a", connectionId: "a" },
    fallbackModels: [
      { provider: pooled.provider, id: pooled.id, apiKey: "key-b", connectionId: "b" },
      ...(withUserBackup ? [{ provider: other.provider, id: other.id, apiKey: "key-z" }] : []),
    ],
    executeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as AgentRunRequest;
}

function pool(): RunModelPool {
  return {
    provider: pooled.provider,
    modelId: pooled.id,
    credential: { id: "a" } as RunModelPool["credential"],
    members: ["b"],
    recordOut: vi.fn(async () => true),
  };
}

async function run(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

const text = (events: AgentRuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");

beforeEach(() => {
  providerState.models.clear();
  for (const target of [pooled, other])
    providerState.models.set(`${target.provider}/${target.id}`, target as never);
  providerState.stream.mockReset();
  providerState.delay.mockReset().mockResolvedValue(undefined);
});

describe("a pooled connection that runs out mid-run", () => {
  it("hands the call to the next connection and rests the one whose credit ran out", async () => {
    const runPool = pool();
    answer({ "key-a": "402 Insufficient credits. Add more credits to continue." });
    expect(text(await run(withRunModelPool(request(), runPool)))).toBe("answered with key-b");
    expect(keysUsed()).toEqual(["key-a", "key-b"]);
    expect(runPool.recordOut).toHaveBeenCalledWith("a", pooled.id, "exhausted", undefined);
  });

  it("rests it until the reset the provider gave", async () => {
    const runPool = pool();
    answer({ "key-a": '429 You exceeded your current quota {"x-ratelimit-reset":"4102444800"}' });
    expect(text(await run(withRunModelPool(request(), runPool)))).toBe("answered with key-b");
    expect(runPool.recordOut).toHaveBeenCalledWith("a", pooled.id, "exhausted", 4_102_444_800_000);
  });

  it("hands over when the provider refuses the connection's key", async () => {
    const runPool = pool();
    answer({ "key-a": "401 invalid_api_key: Incorrect API key provided" });
    expect(text(await run(withRunModelPool(request(), runPool)))).toBe("answered with key-b");
    expect(runPool.recordOut).toHaveBeenCalledWith("a", pooled.id, "rejected", undefined);
  });

  it("hands a subscription whose usage window ran out to the next, resting it until the window resets", async () => {
    const before = Date.now();
    const runPool = pool();
    answer({
      "key-a": "You have hit your ChatGPT usage limit (plus plan). Try again in ~90 min.",
    });
    expect(text(await run(withRunModelPool(request(), runPool)))).toBe("answered with key-b");
    expect(keysUsed()).toEqual(["key-a", "key-b"]);
    const resetAt = vi.mocked(runPool.recordOut).mock.calls[0]?.[3] ?? 0;
    expect(vi.mocked(runPool.recordOut).mock.calls[0]?.slice(0, 3)).toEqual([
      "a",
      pooled.id,
      "exhausted",
    ]);
    expect(resetAt - before).toBeGreaterThanOrEqual(90 * 60_000);
    expect(resetAt - Date.now()).toBeLessThanOrEqual(90 * 60_000);
  });

  it("hands over when the sign-in must be made again", async () => {
    const runPool = pool();
    answer({ "key-a": OAUTH_RECONNECT_REQUIRED_ERROR });
    expect(text(await run(withRunModelPool(request(), runPool)))).toBe("answered with key-b");
    expect(runPool.recordOut).toHaveBeenCalledWith("a", pooled.id, "rejected", undefined);
  });

  it("rests the next one too when it has run out as well, and fails as before", async () => {
    const runPool = pool();
    const spent = "402 Insufficient credits. Add more credits to continue.";
    answer({ "key-a": spent, "key-b": spent });
    await expect(run(withRunModelPool(request(), runPool))).rejects.toThrow(/credits/i);
    expect(keysUsed()).toEqual(["key-a", "key-b"]);
    expect(runPool.recordOut).toHaveBeenNthCalledWith(2, "b", pooled.id, "exhausted", undefined);
  });

  it("does not hand over once the reply has started showing", async () => {
    const runPool = pool();
    answer({ "key-a": "402 Insufficient credits. Add more credits to continue." }, "Partial");
    await expect(run(withRunModelPool(request(), runPool))).rejects.toThrow(/credits/i);
    expect(keysUsed()).toEqual(["key-a"]);
    expect(runPool.recordOut).not.toHaveBeenCalled();
  });
});

describe("a short rate limit on a pooled connection", () => {
  const rateLimit = "429 Rate limit reached: 60 requests per minute. Please retry.";

  it("retries the same connection, never another of the pool", async () => {
    const runPool = pool();
    providerState.stream
      .mockImplementationOnce(() => stream(reply([], rateLimit)))
      .mockImplementation((_target: unknown, _context: unknown, options: { apiKey?: string }) =>
        stream(reply([{ type: "text", text: `answered with ${options.apiKey}` }])),
      );
    expect(text(await run(withRunModelPool(request(), runPool)))).toBe("answered with key-a");
    expect(keysUsed()).toEqual(["key-a", "key-a"]);
    expect(providerState.delay).toHaveBeenCalledOnce();
    expect(runPool.recordOut).not.toHaveBeenCalled();
  });

  it("still hands over when the same connection then runs out", async () => {
    const runPool = pool();
    providerState.stream
      .mockImplementationOnce(() => stream(reply([], rateLimit)))
      .mockImplementationOnce(() =>
        stream(reply([], "402 Insufficient credits. Add more credits to continue.")),
      )
      .mockImplementation((_target: unknown, _context: unknown, options: { apiKey?: string }) =>
        stream(reply([{ type: "text", text: `answered with ${options.apiKey}` }])),
      );
    expect(text(await run(withRunModelPool(request(), runPool)))).toBe("answered with key-b");
    expect(keysUsed()).toEqual(["key-a", "key-a", "key-b"]);
    expect(runPool.recordOut).toHaveBeenCalledOnce();
  });

  it("moves to the person's own backup as before, passing the pool over", async () => {
    const runPool = pool();
    answer({ "key-a": rateLimit });
    expect(text(await run(withRunModelPool(request(true), runPool)))).toBe("answered with key-z");
    expect(keysUsed()).toEqual(["key-a", "key-z"]);
    expect(runPool.recordOut).not.toHaveBeenCalled();
  });
});

describe("a run without a pool", () => {
  it("moves through its backups on a short rate limit exactly as before", async () => {
    answer({ "key-a": "429 Rate limit reached: 60 requests per minute. Please retry." });
    expect(text(await run(request()))).toBe("answered with key-b");
    expect(keysUsed()).toEqual(["key-a", "key-b"]);
  });
});
