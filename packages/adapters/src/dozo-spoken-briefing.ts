import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  ArtifactStore,
  BackgroundJob,
  JobPublisher,
  SecretStore,
  VoiceProvider,
} from "@rakazo/adapter-kit";
import { RetryJobLaterError } from "@rakazo/adapter-kit";
import { deadlineSignal } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  findDefaultVoiceCredential,
  LeaseHeldError,
  recordUsage,
  runAsSystem,
  runAsTenant,
  storedMessageBlocks,
  withLease,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { SpeechAudio } from "./dozo-briefing-audio.js";
import { joinSpeechClips } from "./dozo-briefing-audio.js";
import type { BriefingPersona } from "./dozo-spoken-briefing.prompt.js";
import {
  BRIEFING_MAX_LINES,
  BRIEFING_MAX_SPOKEN_CHARS,
  spokenBriefingInstructions,
  spokenBriefingPrompt,
} from "./dozo-spoken-briefing.prompt.js";
import { HostedModelCreditsRequiredError } from "./models/credits/model-credit-observer.js";
import type { RunContext } from "./runs/assembly/run-context.js";
import { messageBlocksText } from "./runs/assembly/run-replies.prompt.js";
import { resolveRunModel } from "./runs/turn/run-model.js";
import { attachWorkspaceFileToThread } from "./storage/thread-artifacts.js";
import { createVoiceProvider, isVoiceProviderId } from "./voice/voice-factory.js";
import { resolveVoiceKey } from "./voice/voice-model-connection.js";
import { knownVoiceProvider } from "./voice/voice-providers.js";

/**
 * A routine's spoken briefing: when a run of a routine with a co-host completes, its result is
 * written as a short script for the routine's bot and the co-host, each line spoken in its bot's
 * own voice on the owner's own voice connection, and the clips joined into one audio message
 * posted after the result. The text always stays; anything missing (a voice, a connection, a
 * script, a format that joins) leaves the result as the only message.
 */

/** The script's model call. */
const SCRIPT_TIMEOUT_MS = 60_000;
/** One line's speech call. */
const LINE_TIMEOUT_MS = 30_000;
/** A whole briefing: the script, then every line spoken in turn, then the upload. */
export const BRIEFING_TIMEOUT_MS = SCRIPT_TIMEOUT_MS + BRIEFING_MAX_LINES * LINE_TIMEOUT_MS;
/** The backup job of a briefing started at once fires only once that attempt is surely over. */
export const BRIEFING_BACKUP_MS = BRIEFING_TIMEOUT_MS + 60_000;
/** A provider that keeps failing stops being asked; the result stays as text. */
const BRIEFING_MAX_ATTEMPTS = 3;
/** A job that finds another process making the briefing looks again this much later. */
const HELD_RETRY_MS = 60_000;
const LEASE_TTL_MS = 60_000;

export const spokenBriefingJobKey = (runId: string) => `routine.spoken-briefing:${runId}`;

/** The briefing's one job per run: the backup of an attempt under way, or the retry of one that failed. */
export function spokenBriefingJob(runId: string, availableAt: Date): BackgroundJob {
  return {
    name: "routine.spoken-briefing",
    payload: { runId },
    availableAt,
    replaceKey: spokenBriefingJobKey(runId),
    maxAttempts: BRIEFING_MAX_ATTEMPTS,
  };
}

/** The briefing message's key in its chat: a second attempt for the same run writes nothing. */
const briefingNonce = (runId: string) => `dozo-briefing:${runId}`;

type Model = AgentRunRequest["model"];
type Db = Pick<PrismaClient, "$queryRaw">;

export interface SpokenBriefingDeps {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  secretStore: SecretStore;
  artifacts?: ArtifactStore;
  events: Pick<ThreadEvents, "notify" | "publishSpaceChange">;
  /** The routine's bot's own model, which writes the script. */
  resolveModel: (scope: { userId: string; spaceId: string; botId?: string }) => Promise<Model>;
  maxUploadSizeBytes?: number;
  /** The operator's choice that a self-hosted speech server may sit on a private address. */
  allowPrivateEndpoint?: boolean;
}

/** The co-host a routine's briefing is spoken with; null when the routine has none. */
export async function spokenBriefingCoHost(db: Db, routineId: string): Promise<string | null> {
  const [row] = await db.$queryRaw<Array<{ coHostBotId: string }>>`
    SELECT "coHostBotId" FROM dozo_spoken_briefings WHERE "routineId" = ${routineId}`;
  return row?.coHostBotId ?? null;
}

/**
 * The owner's own default voice connection when it can speak, read without opening its secret:
 * the provider it names is available here and declares synthesis. Voice the deployment includes
 * is not used.
 */
async function ownSpeechConnection(
  prisma: PrismaClient,
  owner: { userId: string; spaceId: string },
) {
  const credential = await findDefaultVoiceCredential(prisma, owner);
  if (!credential || !isVoiceProviderId(credential.provider)) return null;
  return createVoiceProvider(credential.provider).describe().capabilities.synthesize
    ? credential
    : null;
}

export async function ownSpeechReady(
  prisma: PrismaClient,
  owner: { userId: string; spaceId: string },
): Promise<boolean> {
  return Boolean(await ownSpeechConnection(prisma, owner));
}

type OwnSpeech = { provider: VoiceProvider; apiKey: string; model?: string };

async function ownSpeech(
  deps: SpokenBriefingDeps,
  owner: { userId: string; spaceId: string },
  signal: AbortSignal,
): Promise<OwnSpeech | null> {
  const credential = await ownSpeechConnection(deps.prisma, owner);
  if (!credential) return null;
  const secret = await deps.prisma.secret.findFirst({
    where: { id: credential.secretId, userId: owner.userId, spaceId: null },
  });
  if (!secret) return null;
  const plaintext = await deps.secretStore.load(secret.ciphertext, { recordId: secret.id, signal });
  const apiKey = await resolveVoiceKey(
    { prisma: deps.prisma, secretStore: deps.secretStore },
    owner,
    credential.provider,
    plaintext,
    signal,
  );
  const provider = createVoiceProvider(credential.provider, {
    allowPrivateEndpoint:
      knownVoiceProvider(credential.provider)?.customEndpoints === true &&
      deps.allowPrivateEndpoint === true,
  });
  return { provider, apiKey, model: credential.speechModel || undefined };
}

export type BriefingLine = { speaker: "A" | "B"; text: string };

/**
 * The script's lines in order, up to the line and spoken-length caps; a line past the length cap
 * ends the script there. Empty unless both hosts speak.
 */
export function parseBriefingScript(text: string): BriefingLine[] {
  const lines: BriefingLine[] = [];
  let spoken = 0;
  for (const raw of text.split("\n")) {
    const match = /^\s*\**([AB])\**\s*:\s*(.+)$/.exec(raw);
    const line = match?.[2]?.replace(/[*_`#]/g, "").trim();
    if (!match || !line) continue;
    if (lines.length === BRIEFING_MAX_LINES || spoken + line.length > BRIEFING_MAX_SPOKEN_CHARS)
      break;
    spoken += line.length;
    lines.push({ speaker: match[1] as "A" | "B", text: line });
  }
  const speakers = new Set(lines.map((line) => line.speaker));
  return speakers.size === 2 ? lines : [];
}

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
/** The runtime's own failure text, as compaction reads it (pi-runtime-errors.ts). */
const RUNTIME_FAILURE = /^(?:I hit a problem:|Unknown model )/i;

type Run = { id: string; spaceId: string; userId: string; botId: string };

/** One tool-less call on the routine's bot's model, counted as setup work of the routine's run. */
async function writeScript(
  deps: SpokenBriefingDeps,
  run: Run,
  prompt: string,
  signal: AbortSignal,
): Promise<BriefingLine[] | null> {
  const scope = { userId: run.userId, spaceId: run.spaceId, botId: run.botId };
  const operationId = `spoken-briefing:${run.id}`;
  const record = async (event: UsageEvent) => {
    await recordUsage(deps.prisma, event, {
      ...scope,
      runId: run.id,
      operationId,
      operationKind: "setup",
    });
  };
  if (!deps.runtime.describe().capabilities.compaction) return null;
  let text = "";
  try {
    const model = await deps.resolveModel(scope);
    for await (const event of deps.runtime.run(
      {
        botId: run.botId,
        threadId: operationId,
        runId: operationId,
        usageOperationKind: "setup",
        onUsage: record,
        prompt,
        instructions: spokenBriefingInstructions(),
        history: [],
        tools: [],
        model: { ...model, thinkingLevel: "off" },
        allowSilentEmpty: true,
      },
      {
        operationId,
        traceId: operationId,
        ...scope,
        signal: deadlineSignal(SCRIPT_TIMEOUT_MS, signal),
      },
    )) {
      if (event.type === "usage" && !event.accounted) await record(event);
      if (event.type === "done" && event.text) text = event.text.trim();
    }
  } catch (error) {
    // Without hosted credits nothing is asked, nor asked again.
    if (error instanceof HostedModelCreditsRequiredError) return null;
    throw error;
  }
  if (RUNTIME_FAILURE.test(text)) throw new Error("spoken briefing script call failed");
  return parseBriefingScript(text);
}

const persona = (bot: BriefingPersona) => ({
  name: bot.name,
  description: bot.description,
  instructions: bot.instructions,
});

/**
 * Makes and posts the briefing of one completed routine run, once: a run whose briefing is in its
 * chat, or that cannot have one, is done. Throws for a failure worth another try (a model or
 * speech call that failed), and `LeaseHeldError` while another process is making it.
 */
export async function makeSpokenBriefing(deps: SpokenBriefingDeps, runId: string): Promise<void> {
  await withLease(deps.prisma, spokenBriefingJobKey(runId), { ttlMs: LEASE_TTL_MS }, (lease) =>
    make(deps, runId, deadlineSignal(BRIEFING_TIMEOUT_MS, lease.signal)),
  );
}

async function make(deps: SpokenBriefingDeps, runId: string, signal: AbortSignal) {
  const { prisma, artifacts } = deps;
  const run = await prisma.run.findFirst({
    where: { id: runId, status: "completed", routineId: { not: null } },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      threadId: true,
      routineId: true,
      thread: { select: { groupId: true } },
    },
  });
  if (!run?.routineId || !artifacts) return;
  const done = await prisma.message.findFirst({
    where: { threadId: run.threadId, clientNonce: briefingNonce(run.id) },
    select: { id: true },
  });
  if (done) return;
  const coHostId = await spokenBriefingCoHost(prisma, run.routineId);
  if (!coHostId || coHostId === run.botId) return;
  const personaFields = {
    id: true,
    name: true,
    description: true,
    instructions: true,
    voiceId: true,
  };
  const [host, coHost] = await Promise.all([
    prisma.bot.findFirst({ where: { id: run.botId }, select: personaFields }),
    // Only the co-host's persona and voice are read: never its memory or its chats.
    prisma.bot.findFirst({
      where: { id: coHostId, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
      select: personaFields,
    }),
  ]);
  if (!host?.voiceId || !coHost?.voiceId) return;
  const replies = await prisma.message.findMany({
    where: { threadId: run.threadId, runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
    select: { id: true, blocks: true },
  });
  const result = replies
    .map((reply) => messageBlocksText(storedMessageBlocks(reply)).trim())
    .filter(Boolean)
    .join("\n\n");
  if (!result) return;
  const speech = await ownSpeech(deps, run, signal);
  if (!speech) return;
  const lines = await writeScript(
    deps,
    run,
    spokenBriefingPrompt({ host: persona(host), coHost: persona(coHost), result }),
    signal,
  );
  if (!lines?.length) return;
  const context: AdapterContext = {
    operationId: `spoken-briefing:${run.id}`,
    traceId: `spoken-briefing:${run.id}`,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    signal,
  };
  const clips: SpeechAudio[] = [];
  // One line at a time: a briefing never sends the provider more than one request at once.
  for (const line of lines) {
    clips.push(
      await speech.provider.synthesize(
        {
          text: line.text,
          voiceId: line.speaker === "A" ? host.voiceId : coHost.voiceId,
          apiKey: speech.apiKey,
          model: speech.model,
          signal: deadlineSignal(LINE_TIMEOUT_MS, signal),
        },
        context,
      ),
    );
  }
  const audio = joinSpeechClips(clips);
  if (!audio) return;
  const extension = audio.mimeType === "audio/wav" ? "wav" : "mp3";
  let seq: number | undefined;
  await attachWorkspaceFileToThread(
    { prisma, artifacts, maxUploadSizeBytes: deps.maxUploadSizeBytes, events: deps.events },
    {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      groupId: run.thread.groupId ?? undefined,
      runId: run.id,
      filePath: `briefing.${extension}`,
      bytes: audio.bytes,
      operationId: context.operationId,
      onAttached: async (tx, artifact) => {
        const blocks = [
          {
            kind: "file" as const,
            artifactId: artifact.id,
            mimeType: artifact.mimeType,
            name: artifact.name,
            size: artifact.size,
          },
        ];
        const message = await createThreadMessageInTransaction(tx, {
          threadId: run.threadId,
          botId: run.botId,
          role: "bot",
          blocks,
          clientNonce: briefingNonce(run.id),
        });
        const event = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "thread.message.created",
          payload: { messageId: message.id, role: "bot", blocks },
        });
        seq = event.seq;
      },
    },
  );
  if (seq !== undefined)
    await bestEffort("spoken briefing message", deps.events.notify(run.threadId, seq));
}

/**
 * The briefing started at once: done or not worth trying, its backup job goes; a failure moves the
 * job to now, where the queue's retries and backoff take over.
 */
async function startNow(
  deps: SpokenBriefingDeps,
  jobs: Pick<JobPublisher, "enqueue" | "cancel">,
  runId: string,
) {
  try {
    await makeSpokenBriefing(deps, runId);
  } catch (error) {
    if (error instanceof LeaseHeldError) return;
    await jobs.enqueue(spokenBriefingJob(runId, new Date()));
    throw error;
  }
  await jobs.cancel(spokenBriefingJobKey(runId));
}

const begin = (work: () => Promise<unknown>) => {
  void bestEffort("spoken briefing", work());
};

/**
 * After a run completed: a routine run whose routine has a co-host gets its briefing's backup job,
 * then the briefing starts in this process. Every other run costs nothing; a routine run one
 * primary-key read. Never fails the run.
 */
export async function dozoSpokenBriefingAfterRun(ctx: RunContext, start = begin): Promise<void> {
  const { deps, run } = ctx;
  if (run.trigger !== "routine" || !run.routineId) return;
  await bestEffort(
    "spoken briefing",
    (async () => {
      if (!(await spokenBriefingCoHost(deps.prisma, run.routineId!))) return;
      await deps.jobs.enqueue(spokenBriefingJob(run.id, new Date(Date.now() + BRIEFING_BACKUP_MS)));
      const briefingDeps: SpokenBriefingDeps = {
        prisma: deps.prisma,
        runtime: deps.runtime,
        secretStore: deps.secretStore,
        artifacts: deps.artifacts,
        events: deps.events,
        resolveModel: (scope) => resolveRunModel(deps, scope),
        maxUploadSizeBytes: deps.maxUploadSizeBytes,
        allowPrivateEndpoint: deps.mcpAllowPrivateEndpoint,
      };
      start(() => startNow(briefingDeps, deps.jobs, run.id));
    })(),
  );
}

/** The briefing's job: the backup of one started at once, or the retry of one that failed. */
export function dozoSpokenBriefingJob(
  deps: Omit<SpokenBriefingDeps, "resolveModel" | "allowPrivateEndpoint"> & {
    executor: { resolveModel: SpokenBriefingDeps["resolveModel"] };
  },
) {
  return async ({ runId }: { runId: string }) => {
    const owner = await runAsSystem("find the run a spoken briefing is for", () =>
      deps.prisma.run.findUnique({ where: { id: runId }, select: { spaceId: true, userId: true } }),
    );
    if (!owner) return;
    try {
      await runAsTenant(owner, () =>
        makeSpokenBriefing({ ...deps, resolveModel: deps.executor.resolveModel }, runId),
      );
    } catch (error) {
      if (error instanceof LeaseHeldError) throw new RetryJobLaterError(HELD_RETRY_MS);
      throw error;
    }
  };
}
