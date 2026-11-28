import type { AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { RetryJobLaterError, VoiceAccountError } from "@rakazo/adapter-kit";
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
import { VoiceProviderUnavailableError } from "./voice/voice-http.js";

const run = {
  id: "run-1",
  spaceId: "space-1",
  userId: "owner",
  botId: "bot-1",
  threadId: "thread-1",
  thread: { groupId: null as string | null },
};
type Bot = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  voiceId: string | null;
  spaceId: string;
  userId: string;
  archivedAt: Date | null;
};
const host: Bot = {
  id: "bot-1",
  name: "Chef",
  description: "",
  instructions: "Be warm.",
  voiceId: "voice-a",
  spaceId: "space-1",
  userId: "owner",
  archivedAt: null,
};
const nova: Bot = {
  ...host,
  id: "bot-2",
  name: "Nova",
  description: "Curious",
  instructions: "",
  voiceId: "voice-b",
};
const work = { runId: "run-1", coHostBotId: "bot-2" };

let world: {
  run: typeof run | null;
  done: boolean;
  bots: Bot[];
  result: string;
  /** What the model answers, call by call; the last one repeats. */
  scripts: Array<string | Error>;
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
    bot: {
      findFirst: vi.fn(
        async ({ where }: { where: Pick<Bot, "id" | "spaceId" | "userId" | "archivedAt"> }) =>
          world.bots.find(
            (bot) =>
              bot.id === where.id &&
              bot.spaceId === where.spaceId &&
              bot.userId === where.userId &&
              bot.archivedAt === where.archivedAt,
          ) ?? null,
      ),
    },
    secret: { findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "sealed" })) },
  };
}

function runtime(): AgentRuntime & { calls: number } {
  const fake = {
    calls: 0,
    describe: () => ({ capabilities: { compaction: true } }),
    async *run(): AsyncGenerator<AgentRuntimeEvent> {
      const script = world.scripts[Math.min(fake.calls, world.scripts.length - 1)]!;
      fake.calls++;
      if (script instanceof Error) throw script;
      yield { type: "usage", inputTokens: 10, outputTokens: 5 } as AgentRuntimeEvent;
      yield { type: "done", text: script } as AgentRuntimeEvent;
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
    bots: [host, nova],
    result: "Three orders shipped. The fourth ships tomorrow.",
    scripts: ["A: Three orders shipped.\nB: And the fourth?\nA: It ships tomorrow."],
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
    retryDelayMs: 0,
  };
});

const unavailable = () => new VoiceProviderUnavailableError();

describe("making a routine run's spoken briefing", () => {
  it("speaks each line in its bot's own voice and posts one audio message after the result", async () => {
    await makeSpokenBriefing(deps, work);
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
    await makeSpokenBriefing(deps, work);
    expect(prompt).toContain("<host_b>\nNova\nCurious\n</host_b>");
    expect(prompt).toContain(
      "<result>\nThree orders shipped. The fourth ships tomorrow.\n</result>",
    );
  });

  it("posts a group chat's briefing into the group", async () => {
    world.run = { ...run, thread: { groupId: "group-1" } };
    await makeSpokenBriefing(deps, work);
    expect(attach.mock.calls[0]?.[1]).toMatchObject({ groupId: "group-1" });
  });

  it.each([
    ["the run's briefing is already in its chat", () => (world.done = true)],
    ["the run is not a completed run", () => (world.run = null)],
    ["the co-host is the routine's own bot", () => (work.coHostBotId = "bot-1")],
    ["the co-host has no voice of its own", () => (world.bots = [host, { ...nova, voiceId: "" }])],
    ["the co-host is archived", () => (world.bots = [host, { ...nova, archivedAt: new Date() }])],
    [
      "the co-host was moved to someone else",
      () => (world.bots = [host, { ...nova, userId: "other" }]),
    ],
    [
      "the routine's bot is archived",
      () => (world.bots = [{ ...host, archivedAt: new Date() }, nova]),
    ],
    [
      "the routine's bot was moved to someone else",
      () => (world.bots = [{ ...host, userId: "other" }, nova]),
    ],
    ["the routine's bot has no voice", () => (world.bots = [{ ...host, voiceId: null }, nova])],
    ["the result has no text", () => (world.result = "  ")],
    ["the owner has no voice connection", () => (db.credential = null)],
    ["the script has one host", () => (world.scripts = ["A: Only me."])],
    [
      "the model needs hosted credits",
      () => (world.scripts = [new HostedModelCreditsRequiredError("no credits")]),
    ],
  ])("posts nothing and throws nothing when %s", async (_case, arrange) => {
    const coHost = work.coHostBotId;
    arrange();
    await makeSpokenBriefing(deps, work);
    work.coHostBotId = coHost;
    expect(attach).not.toHaveBeenCalled();
    expect(deps.events.notify).not.toHaveBeenCalled();
  });

  it("posts nothing without a store for files, or when the clips do not join", async () => {
    await makeSpokenBriefing({ ...deps, artifacts: undefined }, work);
    synthesize.mockResolvedValueOnce({ bytes: new Uint8Array(4), mimeType: "audio/ogg" });
    await makeSpokenBriefing(deps, work);
    expect(attach).not.toHaveBeenCalled();
  });

  it("uploads nothing past the attachment limit", async () => {
    await makeSpokenBriefing({ ...deps, maxUploadSizeBytes: 20 }, work);
    expect(synthesize).toHaveBeenCalledTimes(3);
    expect(attach).not.toHaveBeenCalled();
  });

  it("names a WAV briefing as one", async () => {
    const clip = {
      bytes: pcmToWav(Uint8Array.from([1, 2]), { sampleRate: 24_000, channels: 1 }),
      mimeType: "audio/wav" as const,
    };
    for (const _line of [1, 2, 3]) synthesize.mockResolvedValueOnce(clip);
    await makeSpokenBriefing(deps, work);
    expect(attach.mock.calls[0]?.[1]).toMatchObject({ filePath: "briefing.wav" });
  });

  it("tries a provider that is briefly down again, keeping the script and the lines already spoken", async () => {
    synthesize.mockRejectedValueOnce(unavailable());
    const timeout = new Error("slow");
    timeout.name = "TimeoutError";
    synthesize.mockResolvedValueOnce({
      bytes: new Uint8Array([0xff, 0xfb, 0x90, 0]),
      mimeType: "audio/mpeg",
    });
    synthesize.mockRejectedValueOnce(timeout);
    await makeSpokenBriefing(deps, work);
    expect(deps.runtime.calls).toBe(1);
    expect(synthesize.mock.calls.map(([request]) => request.text)).toEqual([
      "Three orders shipped.",
      "Three orders shipped.",
      "And the fourth?",
      "And the fourth?",
      "It ships tomorrow.",
    ]);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("ends with the text only, at once, on a speech failure that lasts", async () => {
    synthesize.mockRejectedValueOnce(new VoiceAccountError("VOICE_KEY_REJECTED", "refused"));
    await makeSpokenBriefing(deps, work);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(attach).not.toHaveBeenCalled();
  });

  it("ends with the text only once a provider stays down, never asking the model again", async () => {
    synthesize.mockRejectedValue(unavailable());
    await makeSpokenBriefing(deps, work);
    expect(synthesize).toHaveBeenCalledTimes(3);
    expect(deps.runtime.calls).toBe(1);
    expect(attach).not.toHaveBeenCalled();
  });

  it("asks the model again after a failed call, and ends with the text only when it keeps failing", async () => {
    world.scripts = [new Error("network"), "A: One.\nB: Two."];
    await makeSpokenBriefing(deps, work);
    expect(deps.runtime.calls).toBe(2);
    expect(attach).toHaveBeenCalledTimes(1);
    attach.mockClear();
    deps.runtime = runtime();
    world.done = false;
    world.scripts = ["I hit a problem: the provider is down"];
    await expect(makeSpokenBriefing(deps, work)).resolves.toBeUndefined();
    expect(deps.runtime.calls).toBe(3);
    expect(attach).not.toHaveBeenCalled();
  });

  it("ends with the text only when the voice connection's model link is refused", async () => {
    deps.secretStore.load = vi.fn(async () => {
      throw new VoiceAccountError(undefined, "Connect it in Models settings.");
    }) as never;
    await makeSpokenBriefing(deps, work);
    expect(attach).not.toHaveBeenCalled();
  });

  it("throws for a failure outside the model and speech, for the queue to retry", async () => {
    deps.secretStore.load = vi.fn(async () => {
      throw new Error("secret store down");
    }) as never;
    await expect(makeSpokenBriefing(deps, work)).rejects.toThrow("secret store down");
  });

  it("never asks a runtime that cannot make tool-less calls", async () => {
    deps.runtime.describe = () => ({ capabilities: { compaction: false } }) as never;
    await makeSpokenBriefing(deps, work);
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
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      enqueueIn: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };
    const tx = { $queryRaw: vi.fn(async () => [{ coHostBotId: "bot-2" }]) };
    const ctx = {
      run: { id: "run-1", trigger: "routine", routineId: "routine-1" },
      deps: {
        prisma: { ...deps.prisma, $transaction: async (fn: (db: unknown) => unknown) => fn(tx) },
        runtime: deps.runtime,
        secretStore: deps.secretStore,
        artifacts: deps.artifacts,
        events: deps.events,
        jobs,
      },
    } as unknown as RunContext;
    let started: (() => Promise<unknown>) | undefined;
    return {
      ctx,
      jobs,
      start: (next: () => Promise<unknown>) => {
        started = next;
      },
      work: () => started!(),
    };
  }

  it("drops its backup job once the briefing is posted", async () => {
    const started = context();
    await dozoSpokenBriefingAfterRun(started.ctx, started.start);
    await started.work();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(started.jobs.cancel).toHaveBeenCalledWith(spokenBriefingJobKey("run-1"));
  });

  it("drops its backup job when the briefing ends with the text only", async () => {
    synthesize.mockRejectedValue(new VoiceAccountError("VOICE_KEY_REJECTED", "refused"));
    const started = context();
    await dozoSpokenBriefingAfterRun(started.ctx, started.start);
    await started.work();
    expect(started.jobs.cancel).toHaveBeenCalledWith(spokenBriefingJobKey("run-1"));
    expect(started.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("moves its job to now after a failure outside the model and speech", async () => {
    attach.mockRejectedValue(new Error("file store down"));
    const started = context();
    await dozoSpokenBriefingAfterRun(started.ctx, started.start);
    const before = Date.now();
    await expect(started.work()).rejects.toThrow("file store down");
    const [[job]] = started.jobs.enqueue.mock.calls as unknown as [
      [{ availableAt: Date; payload: unknown }],
    ];
    expect(job.payload).toEqual(work);
    expect(job.availableAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(job.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(started.jobs.cancel).not.toHaveBeenCalled();
  });

  it("leaves the job alone while another process makes the briefing", async () => {
    db.leaseHeld = true;
    const started = context();
    await dozoSpokenBriefingAfterRun(started.ctx, started.start);
    await started.work();
    expect(started.jobs.enqueue).not.toHaveBeenCalled();
    expect(started.jobs.cancel).not.toHaveBeenCalled();
  });

  it("makes the briefing from the job as its run's owner, and waits while another process holds it", async () => {
    const job = dozoSpokenBriefingJob({ ...deps, executor: { resolveModel: deps.resolveModel } });
    await job(work);
    expect(attach).toHaveBeenCalledTimes(1);
    db.leaseHeld = true;
    await expect(job(work)).rejects.toBeInstanceOf(RetryJobLaterError);
    world.run = null;
    await expect(job({ runId: "gone", coHostBotId: "bot-2" })).resolves.toBeUndefined();
  });

  it("passes a failure outside the model and speech on to the queue's retries", async () => {
    attach.mockRejectedValue(new Error("file store down"));
    const job = dozoSpokenBriefingJob({ ...deps, executor: { resolveModel: deps.resolveModel } });
    await expect(job(work)).rejects.toThrow("file store down");
  });
});
