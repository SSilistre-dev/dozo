import type { AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { RetryJobLaterError } from "@rakazo/adapter-kit";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  credential: null as null | { provider: string; secretId: string; speechModel: string },
  leaseHeld: false,
  usage: [] as unknown[],
  messages: [] as unknown[],
}));
vi.mock("@rakazo/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...original,
    findDefaultVoiceCredential: vi.fn(async () => db.credential),
    withLease: vi.fn(async (_prisma, key: string, _options, work) => {
      if (db.leaseHeld) throw new original.LeaseHeldError(key);
      return work({ key, fence: 1, signal: new AbortController().signal });
    }),
    recordUsage: vi.fn(async (_prisma, event, attribution) => {
      db.usage.push({ event, attribution });
    }),
    runAsSystem: vi.fn(async (_label: string, work: () => unknown) => work()),
    runAsTenant: vi.fn(async (_tenant: unknown, work: () => unknown) => work()),
    createThreadMessageInTransaction: vi.fn(async (_tx, message) => {
      db.messages.push(message);
      return { id: "message-9" };
    }),
    appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
  };
});
const attach = vi.hoisted(() => vi.fn());
vi.mock("./storage/thread-artifacts.js", () => ({ attachWorkspaceFileToThread: attach }));
vi.mock("./runs/turn/run-model.js", () => ({
  resolveRunModel: vi.fn(async () => ({ provider: "test", modelId: "model" })),
}));

import type { SpokenBriefingDeps } from "./dozo-spoken-briefing.js";
import {
  dozoSpokenBriefingAfterRun,
  dozoSpokenBriefingJob,
  makeSpokenBriefing,
  ownSpeechReady,
  spokenBriefingJobKey,
} from "./dozo-spoken-briefing.js";
import { HostedModelCreditsRequiredError } from "./models/credits/model-credit-observer.js";
import { ScriptedVoiceProvider } from "./providers/voice/scripted/scripted-voice.js";
import type { RunContext } from "./runs/assembly/run-context.js";
import { pcmToWav } from "./voice/pcm-wav.js";

const run = {
  id: "run-1",
  spaceId: "space-1",
  userId: "owner",
  botId: "bot-1",
  threadId: "thread-1",
  routineId: "routine-1",
  thread: { groupId: null as string | null },
};
const host = {
  id: "bot-1",
  name: "Chef",
  description: "",
  instructions: "Be warm.",
  voiceId: "voice-a",
};
const nova = {
  id: "bot-2",
  name: "Nova",
  description: "Curious",
  instructions: "",
  voiceId: "voice-b",
};

let world: {
  run: typeof run | null;
  done: boolean;
  coHost: string | null;
  bots: Array<typeof host>;
  result: string;
  script: string | Error;
  secret: boolean;
};
let synthesize: MockInstance<ScriptedVoiceProvider["synthesize"]>;

function prisma() {
  return {
    run: {
      findFirst: vi.fn(async () => world.run),
      findUnique: vi.fn(async () => world.run && { spaceId: run.spaceId, userId: run.userId }),
    },
    message: {
      findFirst: vi.fn(async () => (world.done ? { id: "message-1" } : null)),
      findMany: vi.fn(async () => [
        { id: "message-1", blocks: [{ kind: "text", text: world.result }] },
      ]),
    },
    $queryRaw: vi.fn(async () => (world.coHost ? [{ coHostBotId: world.coHost }] : [])),
    bot: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          world.bots.find((bot) => bot.id === where.id) ?? null,
      ),
    },
    secret: {
      findFirst: vi.fn(async () =>
        world.secret ? { id: "secret-1", ciphertext: "sealed" } : null,
      ),
    },
  };
}

function runtime(): AgentRuntime & { calls: number } {
  const fake = {
    calls: 0,
    describe: () => ({ capabilities: { compaction: true } }),
    async *run(): AsyncGenerator<AgentRuntimeEvent> {
      fake.calls++;
      if (world.script instanceof Error) throw world.script;
      yield { type: "usage", inputTokens: 10, outputTokens: 5 } as AgentRuntimeEvent;
      yield { type: "done", text: world.script } as AgentRuntimeEvent;
    },
  };
  return fake as unknown as AgentRuntime & { calls: number };
}

let deps: SpokenBriefingDeps & { runtime: AgentRuntime & { calls: number } };

beforeEach(() => {
  vi.stubEnv("AGENT_RUNTIME", "scripted");
  vi.clearAllMocks();
  synthesize = vi.spyOn(ScriptedVoiceProvider.prototype, "synthesize");
  db.credential = { provider: "scripted", secretId: "secret-1", speechModel: "" };
  db.leaseHeld = false;
  db.usage = [];
  db.messages = [];
  world = {
    run: { ...run },
    done: false,
    coHost: "bot-2",
    bots: [host, nova],
    result: "Three orders shipped. The fourth ships tomorrow.",
    script: "A: Three orders shipped.\nB: And the fourth?\nA: It ships tomorrow.",
    secret: true,
  };
  attach.mockImplementation(async (_deps, input) => {
    await input.onAttached("tx", {
      id: "artifact-1",
      mimeType: "audio/mpeg",
      name: "briefing.mp3",
      size: input.bytes.byteLength,
    });
    return { artifactId: "artifact-1" };
  });
  deps = {
    prisma: prisma() as never,
    runtime: runtime(),
    secretStore: { load: vi.fn(async () => "scripted-key") } as never,
    artifacts: {} as never,
    events: {
      notify: vi.fn(async () => undefined),
      publishSpaceChange: vi.fn(async () => undefined),
    },
    resolveModel: vi.fn(async () => ({ provider: "test", modelId: "model" })) as never,
  };
});

describe("making a routine run's spoken briefing", () => {
  it("speaks each line in its bot's own voice and posts one audio message after the result", async () => {
    await makeSpokenBriefing(deps, "run-1");
    expect(synthesize.mock.calls.map(([request]) => [request.voiceId, request.text])).toEqual([
      ["voice-a", "Three orders shipped."],
      ["voice-b", "And the fourth?"],
      ["voice-a", "It ships tomorrow."],
    ]);
    const input = attach.mock.calls[0]?.[1] as { bytes: Uint8Array };
    expect(input).toMatchObject({
      spaceId: "space-1",
      userId: "owner",
      botId: "bot-1",
      groupId: undefined,
      runId: "run-1",
      filePath: "briefing.mp3",
    });
    expect(db.messages).toEqual([
      {
        threadId: "thread-1",
        botId: "bot-1",
        role: "bot",
        clientNonce: "dozo-briefing:run-1",
        blocks: [
          {
            kind: "file",
            artifactId: "artifact-1",
            mimeType: "audio/mpeg",
            name: "briefing.mp3",
            size: input.bytes.byteLength,
          },
        ],
      },
    ]);
    expect(deps.events.notify).toHaveBeenCalledWith("thread-1", 7);
    expect(db.usage).toEqual([
      expect.objectContaining({
        attribution: expect.objectContaining({
          runId: "run-1",
          operationKind: "setup",
          botId: "bot-1",
        }),
      }),
    ]);
  });

  it("shows the co-host only its own name, description and instructions", async () => {
    let prompt = "";
    deps.runtime.run = async function* (request: { prompt: string }) {
      prompt = request.prompt;
      yield { type: "done", text: "A: One.\nB: Two." } as AgentRuntimeEvent;
    } as never;
    await makeSpokenBriefing(deps, "run-1");
    expect(prompt).toContain("<host_b>\nNova\nCurious\n</host_b>");
    expect(prompt).toContain(
      "<result>\nThree orders shipped. The fourth ships tomorrow.\n</result>",
    );
  });

  it("posts a group chat's briefing into the group", async () => {
    world.run = { ...run, thread: { groupId: "group-1" } };
    await makeSpokenBriefing(deps, "run-1");
    expect(attach.mock.calls[0]?.[1]).toMatchObject({ groupId: "group-1" });
  });

  it.each([
    ["the run's briefing is already in its chat", () => (world.done = true)],
    ["the run is not a completed routine run", () => (world.run = null)],
    ["the routine has no co-host", () => (world.coHost = null)],
    ["the co-host is the routine's own bot", () => (world.coHost = "bot-1")],
    ["the co-host has no voice of its own", () => (world.bots = [host, { ...nova, voiceId: "" }])],
    ["the co-host is not the owner's bot here", () => (world.bots = [host])],
    ["the result has no text", () => (world.result = "  ")],
    ["the owner has no voice connection", () => (db.credential = null)],
    ["the connection's secret is gone", () => (world.secret = false)],
    ["the script has one host", () => (world.script = "A: Only me.")],
    [
      "the model needs hosted credits",
      () => (world.script = new HostedModelCreditsRequiredError("no credits")),
    ],
  ])("posts nothing and asks for nothing more when %s", async (_case, arrange) => {
    arrange();
    await makeSpokenBriefing(deps, "run-1");
    expect(attach).not.toHaveBeenCalled();
    expect(deps.events.notify).not.toHaveBeenCalled();
  });

  it("posts nothing without a store for files, or when the clips do not join", async () => {
    await makeSpokenBriefing({ ...deps, artifacts: undefined }, "run-1");
    synthesize.mockResolvedValueOnce({ bytes: new Uint8Array(4), mimeType: "audio/ogg" });
    await makeSpokenBriefing(deps, "run-1");
    expect(attach).not.toHaveBeenCalled();
  });

  it("names a WAV briefing as one", async () => {
    const clip = {
      bytes: pcmToWav(Uint8Array.from([1, 2]), { sampleRate: 24_000, channels: 1 }),
      mimeType: "audio/wav" as const,
    };
    for (const _line of [1, 2, 3]) synthesize.mockResolvedValueOnce(clip);
    await makeSpokenBriefing(deps, "run-1");
    expect(attach.mock.calls[0]?.[1]).toMatchObject({ filePath: "briefing.wav" });
  });

  it("throws for a failed model call, so it is tried again", async () => {
    world.script = "I hit a problem: the provider is down";
    await expect(makeSpokenBriefing(deps, "run-1")).rejects.toThrow("script call failed");
    world.script = new Error("network");
    await expect(makeSpokenBriefing(deps, "run-1")).rejects.toThrow("network");
  });

  it("never asks a runtime that cannot make tool-less calls", async () => {
    deps.runtime.describe = () => ({ capabilities: { compaction: false } }) as never;
    await makeSpokenBriefing(deps, "run-1");
    expect(deps.runtime.calls).toBe(0);
  });
});

describe("the owner's own voice", () => {
  it("is ready only on a connection whose provider is here and speaks", async () => {
    expect(await ownSpeechReady({} as never, { userId: "owner", spaceId: "space-1" })).toBe(true);
    db.credential = { provider: "no-such-provider", secretId: "s", speechModel: "" };
    expect(await ownSpeechReady({} as never, { userId: "owner", spaceId: "space-1" })).toBe(false);
  });
});

describe("the briefing started at once and its job", () => {
  function context() {
    const jobs = { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) };
    const ctx = {
      run: { id: "run-1", trigger: "routine", routineId: "routine-1" },
      deps: {
        prisma: deps.prisma,
        runtime: deps.runtime,
        secretStore: deps.secretStore,
        artifacts: deps.artifacts,
        events: deps.events,
        jobs,
      },
    } as unknown as RunContext;
    let work: (() => Promise<unknown>) | undefined;
    return {
      ctx,
      jobs,
      start: (next: () => Promise<unknown>) => {
        work = next;
      },
      work: () => work!(),
    };
  }

  it("drops its backup job once the briefing is posted", async () => {
    const started = context();
    await dozoSpokenBriefingAfterRun(started.ctx, started.start);
    await started.work();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(started.jobs.cancel).toHaveBeenCalledWith(spokenBriefingJobKey("run-1"));
  });

  it("moves its job to now when the attempt fails, for the queue to try again", async () => {
    world.script = new Error("network");
    const started = context();
    await dozoSpokenBriefingAfterRun(started.ctx, started.start);
    const before = Date.now();
    await expect(started.work()).rejects.toThrow("network");
    const [, [job]] = started.jobs.enqueue.mock.calls as unknown as [
      unknown,
      [{ availableAt: Date }],
    ];
    expect(job.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(job.availableAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(started.jobs.cancel).not.toHaveBeenCalled();
  });

  it("leaves the job alone while another process makes the briefing", async () => {
    db.leaseHeld = true;
    const started = context();
    await dozoSpokenBriefingAfterRun(started.ctx, started.start);
    await started.work();
    expect(started.jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(started.jobs.cancel).not.toHaveBeenCalled();
  });

  it("makes the briefing from the job as its run's owner, and waits while another process holds it", async () => {
    const job = dozoSpokenBriefingJob({ ...deps, executor: { resolveModel: deps.resolveModel } });
    await job({ runId: "run-1" });
    expect(attach).toHaveBeenCalledTimes(1);
    db.leaseHeld = true;
    await expect(job({ runId: "run-1" })).rejects.toBeInstanceOf(RetryJobLaterError);
    world.run = null;
    await expect(job({ runId: "gone" })).resolves.toBeUndefined();
  });

  it("passes a failure on to the queue's retries", async () => {
    world.script = new Error("network");
    const job = dozoSpokenBriefingJob({ ...deps, executor: { resolveModel: deps.resolveModel } });
    await expect(job({ runId: "run-1" })).rejects.toThrow("network");
  });
});
