import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({ record: vi.fn(async () => undefined) }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordUsage: usage.record,
}));

const { createTeachValueSuggester } = await import("./dozo-teach-suggest.js");

const actor = { userId: "ada", spaceId: "space-1", email: "ada@example.test" } as never;
const skill = { botId: "bot-1", goal: "Sign in" };
const values = [
  { placeholder: "{{value 1}}", text: "ali@example.test" },
  { placeholder: "{{value 2}}", text: "Kadıköy" },
];

function runtime(
  reply: (request: AgentRunRequest, signal?: AbortSignal) => AsyncIterable<AgentRuntimeEvent>,
  compaction = true,
) {
  const run = vi.fn((request: AgentRunRequest, context?: { signal?: AbortSignal }) =>
    reply(request, context?.signal),
  );
  return {
    run,
    runtime: {
      describe: () => ({ capabilities: { compaction } }),
      run,
      abort: async () => undefined,
    } as unknown as AgentRuntime,
  };
}

async function* answer(text: string): AsyncIterable<AgentRuntimeEvent> {
  yield { type: "usage", accounted: false } as never;
  yield { type: "done", text } as never;
}

function setup(fake: ReturnType<typeof runtime>, provider = "openai-compatible") {
  const suggest = createTeachValueSuggester({
    prisma: {} as never,
    runtime: fake.runtime,
    resolveModel: async () => ({ provider, model: "m" }) as never,
  });
  return { suggest };
}

describe("createTeachValueSuggester", () => {
  it("names each value from the model's JSON, sending only placeholder and text", async () => {
    const fake = runtime(() =>
      answer(
        'Here:\n```json\n[{"placeholder":"{{value 1}}","name":"E-mail","changesEachTime":false},' +
          '{"placeholder":"{{value 2}}","name":"district","changesEachTime":true},' +
          '{"placeholder":"{{value 9}}","name":"other","changesEachTime":true},' +
          '{"placeholder":"{{value 2}}","name":"!!","changesEachTime":true}]\n```',
      ),
    );
    const { suggest } = setup(fake);
    const result = await suggest(actor, skill, values);
    expect(result).toEqual({
      "{{value 1}}": { name: "e_mail", variable: false },
      "{{value 2}}": { name: "district", variable: true },
    });
    const request = fake.run.mock.calls[0]![0];
    expect(request.tools).toEqual([]);
    expect(request.history).toEqual([]);
    expect(request.model.thinkingLevel).toBe("off");
    expect(request.usageOperationKind).toBe("setup");
    expect(JSON.parse(request.prompt)).toEqual({ task: "Sign in", values });
    expect(usage.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "usage" }),
      expect.objectContaining({ userId: "ada", botId: "bot-1", operationKind: "setup" }),
    );
  });

  it("has nothing to ask without values", async () => {
    const fake = runtime(() => answer("[]"));
    expect(await setup(fake).suggest(actor, skill, [])).toEqual({});
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("gives no suggestion for a malformed answer", async () => {
    for (const text of ["no json here", "[not json]", '[{"placeholder":1}]', "] then ["]) {
      expect(await setup(runtime(() => answer(text))).suggest(actor, skill, values)).toBeNull();
    }
  });

  it("gives no suggestion when the call throws or no model is configured", async () => {
    const throwing = runtime(() => {
      throw new Error("provider down");
    });
    expect(await setup(throwing).suggest(actor, skill, values)).toBeNull();
    const noCompaction = runtime(() => answer("[]"), false);
    expect(await setup(noCompaction).suggest(actor, skill, values)).toBeNull();
    const scripted = runtime(() => answer("[]"));
    expect(await setup(scripted, "scripted").suggest(actor, skill, values)).toBeNull();
    expect(scripted.run).not.toHaveBeenCalled();
  });

  it("gives up when the model does not answer in time", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const slow = runtime(async function* (_request, signal) {
        await new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        );
        yield* answer("[]");
      });
      const pending = setup(slow).suggest(actor, skill, values);
      await vi.waitFor(() => expect(slow.run).toHaveBeenCalled());
      expect(timeout).toHaveBeenCalledWith(8_000);
      deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
      expect(await pending).toBeNull();
    } finally {
      timeout.mockRestore();
    }
  });
});
