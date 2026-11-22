import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree only: the brand rules in pi-runtime-fallback.ts hand a failed call to
// dozo-model-pool.ts, which rests a model that ran out outside a pool (dozo-model-rests.ts). A
// fake provider answers every call; nothing leaves the process.

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

const rests = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  recordModelRest: rests.record,
}));

vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import type { RunModelPool } from "./dozo-model-pool.js";
import { withRunModelPool } from "./dozo-model-pool.js";
import { OAUTH_RECONNECT_REQUIRED_ERROR } from "./pi-oauth.js";
import { PiAgentRuntime } from "./pi-runtime.js";

const main: Model<"openai-completions"> = {
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
const other: Model<"openai-completions"> = { ...main, provider: "provider-z", id: "model-z" };

function reply(content: AssistantMessage["content"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: main.api,
    provider: main.provider,
    model: main.id,
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

const owner = { deps: { prisma: { marker: "prisma" } as never }, run: { userId: "user-1" } };

/** The person's main model on connection "a", with one backup on another provider's connection. */
function request(): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Write the requested result",
    instructions: "",
    history: [],
    tools: [],
    model: { provider: main.provider, id: main.id, apiKey: "key-a", connectionId: "a" },
    fallbackModels: [
      { provider: other.provider, id: other.id, apiKey: "key-z", connectionId: "z" },
    ],
    executeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as AgentRunRequest;
}

async function run(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user-1",
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
  for (const target of [main, other])
    providerState.models.set(`${target.provider}/${target.id}`, target as never);
  providerState.stream.mockReset();
  providerState.delay.mockReset().mockResolvedValue(undefined);
  rests.record.mockReset().mockResolvedValue(true);
});

const HOUR = 60 * 60_000;
/** A reset three hours away, as a provider's reset header gives it, in epoch seconds. */
const SOON = Math.floor((Date.now() + 3 * HOUR) / 1000);

/**
 * Each failure class: whether the model that failed rests, for how long, and that the call moves
 * to the backup either way when the failure lets it. Nothing here waits on a real clock.
 */
const CASES: Array<{
  name: string;
  failure: string;
  rests: "exhausted" | "rejected" | null;
  /** The provider's reset, as epoch milliseconds, when it gave one. */
  until?: number;
}> = [
  {
    name: "out of credit",
    failure: "402 Insufficient credits. Add more credits to continue.",
    rests: "exhausted",
  },
  {
    name: "quota spent, with the provider's reset",
    failure: `429 You exceeded your current quota {"x-ratelimit-reset":"${SOON}"}`,
    rests: "exhausted",
    until: SOON * 1000,
  },
  {
    name: "a subscription's usage window",
    failure: "You have hit your ChatGPT usage limit (plus plan). Try again in ~90 min.",
    rests: "exhausted",
  },
  {
    name: "a refused key",
    failure: "401 invalid_api_key: Incorrect API key provided",
    rests: "rejected",
  },
  { name: "a sign-in to make again", failure: OAUTH_RECONNECT_REQUIRED_ERROR, rests: "rejected" },
  {
    name: "a short rate limit",
    failure: "429 Rate limit reached for requests per minute",
    rests: null,
  },
  { name: "an overloaded provider", failure: "529 overloaded_error: Overloaded", rests: null },
  { name: "a server error", failure: "500 Internal server error", rests: null },
  { name: "a dropped connection", failure: "fetch failed: ECONNRESET", rests: null },
];

describe("a model that fails outside a pool", () => {
  it.each(CASES)("$name: rests it or not, and the backup answers", async (item) => {
    answer({ "key-a": item.failure });
    const before = Date.now();
    expect(text(await run(withRunModelPool(request(), undefined, owner)))).toBe(
      "answered with key-z",
    );
    expect(keysUsed()[0]).toBe("key-a");
    if (!item.rests) {
      expect(rests.record).not.toHaveBeenCalled();
      return;
    }
    expect(rests.record).toHaveBeenCalledTimes(1);
    const [prisma, rest] = rests.record.mock.calls[0]!;
    expect(prisma).toBe(owner.deps.prisma);
    expect(rest).toMatchObject({
      userId: "user-1",
      credentialId: "a",
      modelId: item.rests === "rejected" ? null : main.id,
      reason: item.rests,
    });
    const until = (rest as { resetsAt: Date }).resetsAt.getTime();
    if (item.until) expect(until).toBe(item.until);
    else if (item.rests === "rejected")
      // One refusal may be the provider's mistake: a few minutes, longer only if it repeats.
      expect(until - before).toBeGreaterThanOrEqual(5 * 60_000);
    else
      expect(until - before).toBeGreaterThanOrEqual(
        item.name.includes("window") ? 90 * 60_000 : HOUR,
      );
    if (item.rests === "rejected") expect(until - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  });

  it("rests nothing for a run that does not say whose connections it uses", async () => {
    answer({ "key-a": "402 Insufficient credits. Add more credits to continue." });
    expect(text(await run(withRunModelPool(request(), undefined)))).toBe("answered with key-z");
    expect(rests.record).not.toHaveBeenCalled();
  });

  it("rests nothing once the reply has started showing, and does not switch then", async () => {
    answer({ "key-a": "402 Insufficient credits. Add more credits to continue." }, "Partial");
    await expect(run(withRunModelPool(request(), undefined, owner))).rejects.toThrow(/credits/i);
    expect(keysUsed()).toEqual(["key-a"]);
    expect(rests.record).not.toHaveBeenCalled();
  });

  it("rests a backup that runs out in turn, and fails as before when none is left", async () => {
    const spent = "402 Insufficient credits. Add more credits to continue.";
    answer({ "key-a": spent, "key-z": spent });
    await expect(run(withRunModelPool(request(), undefined, owner))).rejects.toThrow(/credits/i);
    expect(
      rests.record.mock.calls.map(([, rest]) => (rest as { credentialId: string }).credentialId),
    ).toEqual(["a", "z"]);
  });

  it("leaves a pooled connection to its pool, which rests it on its account", async () => {
    const pool: RunModelPool = {
      provider: main.provider,
      modelId: main.id,
      credential: { id: "a" } as RunModelPool["credential"],
      members: [],
      recordOut: vi.fn(async () => true),
    };
    answer({ "key-a": "402 Insufficient credits. Add more credits to continue." });
    expect(text(await run(withRunModelPool(request(), pool, owner)))).toBe("answered with key-z");
    expect(pool.recordOut).toHaveBeenCalledWith("a", main.id, "exhausted", undefined);
    expect(rests.record).not.toHaveBeenCalled();
  });
});
