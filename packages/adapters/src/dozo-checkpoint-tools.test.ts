import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin.tool-definition.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { serializeTurnCheckpoint } from "./turn-checkpoint.js";

const model = {
  provider: "openai-compatible",
  id: "resume-test",
  baseUrl: "http://127.0.0.1:9/v1",
  allowPrivateEndpoint: true,
  contextWindow: 128_000,
  maxTokens: 1024,
};

// The model answers every request with one short reply and records the tools it was offered.
function fakeModel(offered: string[][]) {
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      tools?: Array<{ function: { name: string } }>;
    };
    offered.push((body.tools ?? []).map((tool) => tool.function.name));
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(
      `${chunk({ role: "assistant", content: "Reminder set." })}${chunk({}, "stop")}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  return fetch;
}

const ARGS = { name: "Report", prompt: "Send the weekly report.", runAt: "2026-01-02T09:00:00Z" };

/** A turn that paused on a direct schedule_create call, as it was listed before the deploy. */
const pausedOnScheduleCreate = serializeTurnCheckpoint({
  version: 1,
  provider: model.provider,
  model: model.id,
  systemPrompt: "You are a test bot.",
  pendingToolCallId: "call-1",
  executionMode: "sequential",
  messages: [
    { role: "user", content: "remind me tomorrow at 9", timestamp: 0 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "schedule_create",
          arguments: ARGS,
        },
      ],
      stopReason: "toolUse",
    },
  ] as never,
});

async function resume(tools: typeof builtinAgentTools) {
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const offered: string[][] = [];
  const events: Array<{ type: string; text?: string }> = [];
  const runtime = new PiAgentRuntime({ modelFetch: fakeModel(offered) });
  for await (const event of runtime.run(
    {
      botId: "b",
      threadId: "t",
      runId: "resume",
      prompt: "approved",
      instructions: "You are a test bot.",
      history: [],
      tools,
      model,
      turnCheckpoint: pausedOnScheduleCreate,
      executeTool: async (name, args) => {
        executed.push({ name, args });
        return { ok: true, routineId: "routine-1" };
      },
    },
    { signal: AbortSignal.timeout(20_000) } as never,
  ))
    events.push(event as { type: string; text?: string });
  return { executed, offered, events };
}

describe("a turn paused on a built-in that is now deferred", () => {
  it("resumes the approved call on it instead of failing the run", async () => {
    const { executed, offered, events } = await resume(builtinAgentTools);
    expect(offered[0]).not.toContain("schedule_create");
    expect(executed).toEqual([{ name: "schedule_create", args: ARGS }]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Reminder set." });
  });

  it("still refuses a call to a tool the run no longer offers", async () => {
    const tools = builtinAgentTools.filter((tool) => tool.name !== "schedule_create");
    await expect(resume(tools)).rejects.toThrow("Pending checkpoint tool is no longer available");
  });
});
