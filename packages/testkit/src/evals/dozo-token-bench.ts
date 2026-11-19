import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { builtinAgentTools } from "../../../adapters/src/builtin.tool-definition.js";
import { diskNoteInstruction } from "../../../adapters/src/computer-disk.js";
import { formatRecalledMemory } from "../../../adapters/src/history-compaction.prompt.js";
import { PiAgentRuntime } from "../../../adapters/src/pi-runtime.js";
import {
  connectedPluginsInstruction,
  runIdentityInstruction,
  taughtSkillsInstruction,
  userTurnInstructions,
} from "../../../adapters/src/run-instructions.prompt.js";
import { runReplyGuidance } from "../../../adapters/src/run-replies.prompt.js";
import type { EvalPricing, MeasuredCall } from "./measurement.js";
import { measureCalls } from "./measurement.js";

/**
 * Offline token benchmark. A fixed task set runs through the real Pi runtime; only the model
 * endpoint is fake. The fake counts tokens from the request body it is sent and models a prefix
 * cache, so the numbers move when what Dozo sends changes, and never with the network.
 */
export const BENCH_VERSION = "dozo-token-bench-v3";

/** The fake model's rules, stored with every result so a baseline says what it measured. */
export const FAKE_PROVIDER = {
  tokenizer: "ceil(utf8 bytes / 4) per request part",
  cache:
    "prefix cache per thread: a request reads the longest byte prefix it shares with an earlier request of the same thread, up to what that request wrote; every request of at least minimumTokens writes its block-aligned prefix",
  minimumTokens: 1024,
  blockTokens: 128,
} as const;

export type ScriptedReply =
  | { text: string }
  | { tool: string; args: Record<string, unknown> }
  | { tools: Array<{ tool: string; args: Record<string, unknown> }> };

export type BenchTurn = {
  prompt: string;
  /** What the server would recall for this turn: placed first in history, as it does. */
  recalled?: string[];
  /** The model's replies for this turn, in order; an exhausted script answers "Done." */
  replies: ScriptedReply[];
  /** The order the database returns the task's records in this turn (indexes into them). */
  recordOrder?: number[];
  /** The bot computer's disk as last measured before this turn, in GB. */
  disk?: { usedGb: number; freeGb: number };
};

/** A saved row the server lists in the system prompt: a taught skill or a connected plugin. */
export type BenchRecord = { id: string; createdAt: string; name: string };

export type BenchTask = {
  id: string;
  kind: "short-chat" | "long-tool-result" | "multi-page" | "long-history" | "memory-recall";
  history?: AgentRunRequest["history"];
  /** Extra system prompt text the server adds for this bot, such as its memory file. */
  memoryContext?: string;
  /** Taught skills and connected plugins, which the server reads from the database every turn. */
  records?: BenchRecord[];
  turns: BenchTurn[];
  /** Deterministic tool output by tool name and arguments. */
  toolResult?: (name: string, args: Record<string, unknown>) => unknown;
};

/** The parts of a request the input tokens are split into. */
export const COMPONENTS = [
  "system",
  "tools",
  "history",
  "prompt",
  "toolCalls",
  "toolResults",
] as const;
export type Component = (typeof COMPONENTS)[number];

type WireMessage = { role: string; content?: unknown; tool_calls?: unknown[] };
export type WireBody = { messages: WireMessage[]; tools?: unknown[] };

export const tokensOf = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);

/** Splits one request into components. The current turn starts at the last plain user message. */
export function requestComponents(body: WireBody): Record<Component, number> {
  const parts = Object.fromEntries(COMPONENTS.map((c) => [c, 0])) as Record<Component, number>;
  parts.tools = body.tools?.length ? tokensOf(JSON.stringify(body.tools)) : 0;
  const lastUser = body.messages.findLastIndex((m) => m.role === "user");
  body.messages.forEach((message, index) => {
    const tokens = tokensOf(JSON.stringify(message));
    const part: Component =
      message.role === "system" || message.role === "developer"
        ? "system"
        : index < lastUser
          ? "history"
          : message.role === "user"
            ? "prompt"
            : message.role === "tool"
              ? "toolResults"
              : "toolCalls";
    parts[part] += tokens;
  });
  return parts;
}

/** The bytes a prefix cache compares, in the order providers cache them: tools, then messages. */
export const prefixText = (body: WireBody) =>
  [JSON.stringify(body.tools ?? []), ...body.messages.map((m) => JSON.stringify(m))].join("\n");

function sharedPrefixBytes(a: string, b: string) {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  const end = Math.min(left.length, right.length);
  let i = 0;
  while (i < end && left[i] === right[i]) i++;
  return i;
}

const blockFloor = (tokens: number) =>
  Math.floor(tokens / FAKE_PROVIDER.blockTokens) * FAKE_PROVIDER.blockTokens;

/** Usage the fake reports for one request, given the prefixes the thread has written so far. */
export function fakeUsage(body: WireBody, written: string[], outputTokens: number) {
  const components = requestComponents(body);
  const promptTokens = COMPONENTS.reduce((n, c) => n + components[c], 0);
  const text = prefixText(body);
  const cacheable = promptTokens >= FAKE_PROVIDER.minimumTokens;
  let read = 0;
  if (cacheable)
    for (const earlier of written)
      read = Math.max(
        read,
        blockFloor(Math.min(sharedPrefixBytes(text, earlier), Buffer.byteLength(earlier)) / 4),
      );
  read = Math.min(read, blockFloor(promptTokens));
  const write = cacheable ? blockFloor(promptTokens) - read : 0;
  if (cacheable) written.push(text);
  return {
    components,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: outputTokens,
      total_tokens: promptTokens + outputTokens,
      prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write },
    },
  };
}

function sse(reply: ScriptedReply, usage: unknown, call: number) {
  const chunk = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: `bench-${call}`, object: "chat.completion.chunk", created: 0, model: "bench", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const calls = "text" in reply ? [] : "tools" in reply ? reply.tools : [reply];
  const body =
    "text" in reply
      ? chunk({ role: "assistant", content: reply.text }) + chunk({}, "stop")
      : chunk({
          role: "assistant",
          tool_calls: calls.map((c, index) => ({
            index,
            id: `call_${call}_${index}`,
            type: "function",
            function: { name: c.tool, arguments: JSON.stringify(c.args) },
          })),
        }) + chunk({}, "tool_calls");
  return `${body}data: ${JSON.stringify({ id: `bench-${call}`, choices: [], usage })}\n\ndata: [DONE]\n\n`;
}

function replyTokens(reply: ScriptedReply) {
  if ("text" in reply) return tokensOf(reply.text);
  const calls = "tools" in reply ? reply.tools : [reply];
  return calls.reduce((n, c) => n + tokensOf(c.tool + JSON.stringify(c.args)), 0);
}

export type BenchCall = MeasuredCall & {
  components: Record<Component, number>;
  /** The request as sent, for tests that compare consecutive calls. */
  body: WireBody;
};

/** A fake endpoint for one task: scripted replies, computed usage, per-thread prefix cache. */
export function fakeModelFetch(script: ScriptedReply[], calls: BenchCall[]) {
  const written: string[] = [];
  let next = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as WireBody;
    const reply = script[next++] ?? { text: "Done." };
    const { components, usage } = fakeUsage(body, written, replyTokens(reply));
    calls.push({
      id: `call-${calls.length + 1}`,
      components,
      body,
      inputTokens:
        usage.prompt_tokens -
        usage.prompt_tokens_details.cached_tokens -
        usage.prompt_tokens_details.cache_write_tokens,
      outputTokens: usage.completion_tokens,
      cacheReadTokens: usage.prompt_tokens_details.cached_tokens,
      cacheWriteTokens: usage.prompt_tokens_details.cache_write_tokens,
      cacheWrite1hTokens: 0,
    });
    return new Response(sse(reply, usage, calls.length), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  return fetch;
}

/**
 * The records as the server lists them, from the rows in the order the database returned them:
 * sorted by creation time, then id, as the brand rules make both queries do.
 */
export function listedRecords(records: BenchRecord[], order?: number[]) {
  return (order ?? records.map((_, i) => i))
    .map((i) => records[i]!)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** A typical system prompt: every built-in tool offered, rendered from fixed placeholders. */
export function benchInstructions(
  memoryContext?: string,
  records?: BenchRecord[],
  disk?: BenchTurn["disk"],
) {
  return userTurnInstructions({
    botInstructions: runIdentityInstruction(
      { name: "Bench", description: "Helps with research.", instructions: "Answer briefly." },
      "user",
    ),
    groupContext: undefined,
    messagingContext: undefined,
    redactedMemoryContext: memoryContext,
    redactedScratchpadContext: undefined,
    hasHistoricalContext: true,
    historyRetrievalEnabled: true,
    computerInstruction: disk
      ? (diskNoteInstruction({
          diskUsedBytes: BigInt(Math.round(disk.usedGb * 1e9)),
          diskFreeBytes: BigInt(Math.round(disk.freeGb * 1e9)),
        }) ?? "")
      : "",
    pageBrowserAllowed: true,
    workspaceInstruction: "",
    agentEnvironmentInstruction: undefined,
    botDirectory: undefined,
    pluginLine: records
      ? connectedPluginsInstruction(
          records.map((r) => ({ displayName: r.name, connectorId: "mcp", provider: r.id })),
        )
      : undefined,
    agentSkillsLine: undefined,
    taughtSkillsLine: records
      ? taughtSkillsInstruction(records.map((r) => ({ name: r.name, whenToUse: r.name })))
      : undefined,
    replyGuidance: runReplyGuidance("user"),
  })
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export const BENCH_MODEL: AgentRunRequest["model"] = {
  provider: "openai-compatible",
  id: "bench",
  baseUrl: "http://127.0.0.1:9/v1",
  allowPrivateEndpoint: true,
  contextWindow: 128_000,
  maxTokens: 4096,
  cacheCapabilities: { scope: "connection", minimumTokens: FAKE_PROVIDER.minimumTokens },
};

const sum = (values: Array<number | null>) =>
  values.every((v) => v !== null) ? values.reduce<number>((n, v) => n + v!, 0) : null;

/** Runs one task: its turns in order on one bot and thread, history carried between turns. */
export async function runBenchTask(task: BenchTask, pricing?: EvalPricing) {
  const calls: BenchCall[] = [];
  const script = task.turns.flatMap((turn) => turn.replies);
  const runtime = new PiAgentRuntime({ modelFetch: fakeModelFetch(script, calls) });
  const history: AgentRunRequest["history"] = [...(task.history ?? [])];
  const tools = builtinAgentTools;
  for (const [index, turn] of task.turns.entries()) {
    const recalled = turn.recalled?.length
      ? [
          {
            role: "user" as const,
            content: formatRecalledMemory(turn.recalled.map((memory) => ({ memory }))),
          },
        ]
      : [];
    const records = task.records && listedRecords(task.records, turn.recordOrder);
    const instructions = benchInstructions(task.memoryContext, records, turn.disk);
    let answer = "";
    for await (const event of runtime.run(
      {
        botId: "bench-bot",
        threadId: `bench-${task.id}`,
        runId: `bench-${task.id}-${index + 1}`,
        prompt: turn.prompt,
        instructions,
        history: [...recalled, ...history],
        tools,
        model: BENCH_MODEL,
        executeTool: async (name, args) =>
          task.toolResult?.(name, args) ?? { ok: true, note: `No fixture output for ${name}` },
      },
      { signal: AbortSignal.timeout(30_000) },
    )) {
      if (event.type === "done") answer = event.text ?? "";
    }
    history.push({ role: "user", content: turn.prompt }, { role: "assistant", content: answer });
  }
  // The fake reports every bucket on every call, so these sums are never partial.
  const total = (key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") =>
    calls.reduce((n, call) => n + Number(call[key]), 0);
  return {
    id: task.id,
    kind: task.kind,
    modelCalls: calls.length,
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    cacheReadTokens: total("cacheReadTokens"),
    cacheWriteTokens: total("cacheWriteTokens"),
    costUsd: measureCalls(calls, pricing).costUsd,
    components: Object.fromEntries(
      COMPONENTS.map((c) => [c, calls.reduce((n, call) => n + call.components[c], 0)]),
    ) as Record<Component, number>,
  };
}

export type BenchTaskResult = Awaited<ReturnType<typeof runBenchTask>>;

export async function runTokenBench(tasks: readonly BenchTask[], pricing?: EvalPricing) {
  const results: BenchTaskResult[] = [];
  for (const task of tasks) results.push(await runBenchTask(task, pricing));
  const total = (key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") =>
    results.reduce((n, r) => n + r[key], 0);
  const promptTokens = total("inputTokens") + total("cacheReadTokens") + total("cacheWriteTokens");
  return {
    version: BENCH_VERSION,
    fakeProvider: FAKE_PROVIDER,
    pricing: pricing ? { source: pricing.source, version: pricing.version } : null,
    totals: {
      modelCalls: results.reduce((n, r) => n + r.modelCalls, 0),
      /** Every prompt token sent, whichever bucket it was billed in. */
      promptTokens,
      inputTokens: total("inputTokens"),
      outputTokens: total("outputTokens"),
      cacheReadTokens: total("cacheReadTokens"),
      cacheWriteTokens: total("cacheWriteTokens"),
      cacheReadShare: promptTokens ? total("cacheReadTokens") / promptTokens : 0,
      costUsd: sum(results.map((r) => r.costUsd)),
      components: Object.fromEntries(
        COMPONENTS.map((c) => [c, results.reduce((n, r) => n + r.components[c], 0)]),
      ) as Record<Component, number>,
    },
    tasks: results,
  };
}

export type TokenBenchReport = Awaited<ReturnType<typeof runTokenBench>>;
