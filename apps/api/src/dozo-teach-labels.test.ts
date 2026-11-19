import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({ record: vi.fn(async () => undefined) }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordUsage: usage.record,
}));

const { createTeachClickLabeller } = await import("./dozo-teach-labels.js");

const actor = { userId: "ada", spaceId: "space-1", email: "ada@example.test" } as never;
const skill = { botId: "bot-1", goal: "Sign in" };
const pictures = [
  { id: "0", image: Buffer.from("one").toString("base64") },
  { id: "5", image: Buffer.from("two").toString("base64") },
];

function runtime(reply: (request: AgentRunRequest) => AsyncIterable<AgentRuntimeEvent>) {
  const run = vi.fn((request: AgentRunRequest) => reply(request));
  return {
    run,
    runtime: {
      describe: () => ({ capabilities: { compaction: true } }),
      run,
      abort: async () => undefined,
    } as unknown as AgentRuntime,
  };
}

async function* answer(text: string): AsyncIterable<AgentRuntimeEvent> {
  yield { type: "done", text } as never;
}

function setup(fake: ReturnType<typeof runtime>, model: Record<string, unknown> = {}) {
  return createTeachClickLabeller({
    prisma: {} as never,
    runtime: fake.runtime,
    resolveModel: async () =>
      ({ provider: "openai-compatible", id: "m", acceptsImages: true, ...model }) as never,
  });
}

describe("createTeachClickLabeller", () => {
  it("names each click from the model's JSON, sending the pictures and the task only", async () => {
    const fake = runtime(() =>
      answer(
        'Sure:\n[{"id":"0","label":"  Email   field "},{"id":"5","label":"' +
          "x".repeat(100) +
          '"},{"id":"9","label":"Ghost"},{"id":"0","label":""}]',
      ),
    );
    const labels = await setup(fake)(actor, skill, pictures);
    // An id never asked about is dropped; an empty label does not replace a real one.
    expect(labels).toEqual({ "0": "Email field", "5": "x".repeat(60) });
    const request = fake.run.mock.calls[0]![0];
    expect(request.tools).toEqual([]);
    expect(request.history).toEqual([]);
    expect(request.usageOperationKind).toBe("setup");
    expect(JSON.parse(request.prompt)).toEqual({ task: "Sign in", pictures: ["0", "5"] });
    expect(request.currentTurnImages?.map((image) => [image.name, image.mimeType])).toEqual([
      ["click-0.webp", "image/webp"],
      ["click-5.webp", "image/webp"],
    ]);
    expect(Buffer.from(request.currentTurnImages![0]!.data as Uint8Array).toString()).toBe("one");
  });

  it("sends at most twenty pictures, and no more than the model takes", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ id: String(index), image: "AAAA" }));
    const fake = runtime(() => answer("[]"));
    await setup(fake)(actor, skill, many);
    expect(fake.run.mock.calls[0]![0].currentTurnImages).toHaveLength(20);
    const few = runtime(() => answer("[]"));
    await setup(few, { maxImagesPerPrompt: 3 })(actor, skill, many);
    expect(few.run.mock.calls[0]![0].currentTurnImages).toHaveLength(3);
  });

  it("has nothing to ask without pictures", async () => {
    const fake = runtime(() => answer("[]"));
    expect(await setup(fake)(actor, skill, [])).toEqual({});
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("gives no labels for a model that cannot see pictures or none configured", async () => {
    const blind = runtime(() => answer("[]"));
    expect(await setup(blind, { acceptsImages: false })(actor, skill, pictures)).toBeNull();
    const scripted = runtime(() => answer("[]"));
    expect(await setup(scripted, { provider: "scripted" })(actor, skill, pictures)).toBeNull();
    expect(blind.run).not.toHaveBeenCalled();
    expect(scripted.run).not.toHaveBeenCalled();
  });

  it("gives no labels for a malformed answer or a failed call", async () => {
    for (const text of ["no json", "[not json]", '[{"id":1}]']) {
      expect(await setup(runtime(() => answer(text)))(actor, skill, pictures)).toBeNull();
    }
    const throwing = runtime(() => {
      throw new Error("provider down");
    });
    expect(await setup(throwing)(actor, skill, pictures)).toBeNull();
  });
});
