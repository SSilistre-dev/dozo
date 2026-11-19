import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({ record: vi.fn(async () => undefined) }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordUsage: usage.record,
}));

const { createTeachValueSuggester, teachValueShape } = await import("./dozo-teach-suggest.js");

const actor = { userId: "ada", spaceId: "space-1", email: "ada@example.test" } as never;
const skill = {
  botId: "bot-1",
  goal: "Sign in",
  steps: ["Type {{value 1}}.", "Press key: Tab.", "Type {{value 2}}."],
};
const values = [
  { placeholder: "{{value 1}}", shape: "9-20 characters, has @" },
  { placeholder: "{{value 2}}", shape: "4-8 characters" },
];

function runtime(
  reply: (request: AgentRunRequest, signal?: AbortSignal) => AsyncIterable<AgentRuntimeEvent>,
) {
  const run = vi.fn((request: AgentRunRequest, context?: { signal?: AbortSignal }) =>
    reply(request, context?.signal),
  );
  return {
    run,
    runtime: {
      describe: () => ({ capabilities: {} }),
      run,
      abort: async () => undefined,
    } as unknown as AgentRuntime,
  };
}

async function* answer(text: string): AsyncIterable<AgentRuntimeEvent> {
  yield { type: "usage", accounted: false } as never;
  yield { type: "done", text } as never;
}

function setup(fake: ReturnType<typeof runtime>, resolveModel?: () => Promise<never>) {
  const suggest = createTeachValueSuggester({
    prisma: {} as never,
    runtime: fake.runtime,
    resolveModel: resolveModel ?? (async () => ({ provider: "scripted", model: "m" }) as never),
  });
  return { suggest };
}

describe("teachValueShape", () => {
  it("tells the length class and the kinds of characters, never a character", () => {
    const shape = (text: string | null, secret = false) =>
      teachValueShape({ placeholder: "{{value 1}}", text, secret }).shape;
    expect(shape("ali@example.test")).toBe("9-20 characters, has @");
    expect(shape("Gizli-5678")).toBe("9-20 characters, letters and digits");
    expect(shape("4821")).toBe("4-8 characters, digits only");
    expect(shape("my secret phrase")).toBe("9-20 characters, has spaces");
    expect(shape("ab")).toBe("1-3 characters");
    expect(shape("x".repeat(30))).toBe("21-60 characters");
    expect(shape("x".repeat(61))).toBe("over 60 characters");
    expect(shape(null, true)).toBe("protected input");
    expect(shape(null)).toBe("unknown");
  });
});

describe("createTeachValueSuggester", () => {
  it("names each value from the model's JSON, sending task, steps, titles and shapes", async () => {
    const fake = runtime(() =>
      answer(
        'Here:\n```json\n[{"placeholder":"{{value 1}}","name":"E-mail"},' +
          '{"placeholder":"{{value 2}}","name":"district"},' +
          '{"placeholder":"{{value 9}}","name":"other"},' +
          '{"placeholder":"{{value 2}}","name":"!!"}]\n```',
      ),
    );
    const result = await setup(fake).suggest(actor, skill, values);
    // An unusable name leaves the one before it; an unknown placeholder is ignored.
    expect(result).toEqual({
      "{{value 1}}": { name: "e_mail" },
      "{{value 2}}": { name: "district" },
    });
    const request = fake.run.mock.calls[0]![0];
    expect(request.tools).toEqual([]);
    expect(request.history).toEqual([]);
    expect(request.model.thinkingLevel).toBe("off");
    expect(request.usageOperationKind).toBe("setup");
    expect(JSON.parse(request.prompt)).toEqual({
      task: "Sign in",
      steps: skill.steps,
      values,
    });
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

  it("gives no suggestion when the call or the model lookup throws", async () => {
    const throwing = runtime(() => {
      throw new Error("provider down");
    });
    expect(await setup(throwing).suggest(actor, skill, values)).toBeNull();
    const unresolved = runtime(() => answer("[]"));
    const failing = async () => {
      throw new Error("no model");
    };
    expect(await setup(unresolved, failing).suggest(actor, skill, values)).toBeNull();
    expect(unresolved.run).not.toHaveBeenCalled();
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
