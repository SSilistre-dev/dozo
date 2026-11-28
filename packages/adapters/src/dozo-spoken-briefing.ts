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
import { RetryJobLaterError, VoiceAccountError } from "@rakazo/adapter-kit";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { deadlineSignal, retry } from "@rakazo/core";
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
import { bestEffort, getLogger } from "@rakazo/logging";
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
import { VoiceProviderUnavailableError } from "./voice/voice-http.js";
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
/**
 * A whole briefing, waits between tries included: the script, then every line spoken in turn,
 * then the upload. Past it the attempt ends and the result stays as text.
 */
export const BRIEFING_TIMEOUT_MS = 2 * SCRIPT_TIMEOUT_MS + BRIEFING_MAX_LINES * LINE_TIMEOUT_MS;
/** The backup job of a briefing started at once fires only once that attempt is surely over. */
export const BRIEFING_BACKUP_MS = BRIEFING_TIMEOUT_MS + 60_000;
/**
 * The most briefings one routine speaks in a day (UTC); past it the routine delivers text only, so
 * a routine that runs every few minutes cannot keep spending on speech.
 */
export const BRIEFINGS_PER_DAY = 3;
/**
 * Tries of one model or speech call within an attempt. A transient failure is tried again there,
 * so the script and the clips already spoken are kept; once the tries are used up, or for any
 * other failure, the attempt ends with the text only.
 */
const CALL_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
/**
 * Runs of the job: the backup after a process stopped mid-briefing, and one more after a failure
 * outside the model and speech calls (the database, the file store).
 */
const BRIEFING_JOB_ATTEMPTS = 2;
/** A job that finds another process making the briefing looks again this much later. */
const HELD_RETRY_MS = 60_000;
const LEASE_TTL_MS = 60_000;

export const spokenBriefingJobKey = (runId: string) => `routine.spoken-briefing:${runId}`;

/** What a briefing needs, carried with its job: the routine and its row may be gone by then. */
export type SpokenBriefingWork = { runId: string; coHostBotId: string };

/** The briefing's one job per run: the backup of an attempt under way, or the retry of one that failed. */
export function spokenBriefingJob(work: SpokenBriefingWork, availableAt: Date): BackgroundJob {
  return {
    name: "routine.spoken-briefing",
    payload: work,
    availableAt,
    replaceKey: spokenBriefingJobKey(work.runId),
    maxAttempts: BRIEFING_JOB_ATTEMPTS,
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
  /** The wait between tries of a call; tests pass 0. */
  retryDelayMs?: number;
}

/** The co-host a routine's briefing is spoken with; null when the routine has none. */
export async function spokenBriefingCoHost(db: Db, routineId: string): Promise<string | null> {
  const [row] = await db.$queryRaw<Array<{ coHostBotId: string }>>`
    SELECT "coHostBotId" FROM dozo_spoken_briefings WHERE "routineId" = ${routineId}`;
  return row?.coHostBotId ?? null;
}

/**
 * Takes one of the routine's briefings of the day (UTC) in one statement, and returns its co-host;
 * null when the routine has none or its briefings of the day are used up.
 */
export async function takeSpokenBriefing(db: Db, routineId: string): Promise<string | null> {
  const [row] = await db.$queryRaw<Array<{ coHostBotId: string }>>`
    UPDATE dozo_spoken_briefings SET
      "day" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,
      "spoken" = CASE WHEN "day" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
        THEN "spoken" + 1 ELSE 1 END
    WHERE "routineId" = ${routineId}
      AND ("day" IS DISTINCT FROM (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
        OR "spoken" < ${BRIEFINGS_PER_DAY})
    RETURNING "coHostBotId"`;
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
/**
 * The runtime's own failure text. Copied from `apps/api/src/calls/speech-summary.ts` and the
 * learning review, which read a tool-less call the same way (the text is pi-runtime-errors.ts').
 */
const RUNTIME_FAILURE = /^(?:I hit a problem:|Unknown model )/i;

class ScriptCallFailed extends Error {
  override readonly name = "ScriptCallFailed";
}

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
  // No capability names a tool-less call; compaction is one, and the spoken summary
  // (speech-summary.ts) and the learning review ask this same capability for theirs.
  if (!deps.runtime.describe().capabilities.compaction) return null;
  const model = await deps.resolveModel(scope);
  let text = "";
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
  if (RUNTIME_FAILURE.test(text)) throw new ScriptCallFailed("spoken briefing script call failed");
  return parseBriefingScript(text);
}

/** A speech call worth another try: the provider is down or did not answer in time. */
const transientSpeech = (error: unknown) =>
  error instanceof VoiceProviderUnavailableError ||
  (error instanceof Error && error.name === "TimeoutError");

/** Any model failure but a refusal for credits is worth another try. */
const transientModel = (error: unknown) => !(error instanceof HostedModelCreditsRequiredError);

const persona = (bot: BriefingPersona) => ({
  name: bot.name,
  description: bot.description,
  instructions: bot.instructions,
});

/**
 * Makes and posts the briefing of one completed routine run, once: a run whose briefing is in its
 * chat, or that cannot have one, is done. A model or speech call is tried again within the attempt
 * while its failure is transient; a lasting failure ends it with the text only. Throws for a
 * failure elsewhere (the database, the file store), and `LeaseHeldError` while another process is
 * making it.
 */
export async function makeSpokenBriefing(
  deps: SpokenBriefingDeps,
  work: SpokenBriefingWork,
): Promise<void> {
  await withLease(deps.prisma, spokenBriefingJobKey(work.runId), { ttlMs: LEASE_TTL_MS }, (lease) =>
    make(deps, work, deadlineSignal(BRIEFING_TIMEOUT_MS, lease.signal)),
  );
}

/** Why a briefing ended with the text only, for the log; never shown. */
const textOnly = (runId: string, reason: string, error?: unknown) => {
  getLogger().warn("spoken briefing left as text", {
    "run.id": runId,
    reason,
    ...(error instanceof Error ? { error: error.name } : {}),
  });
};

/** The owner's speech; null, logged, when a linked model connection is gone or refused. */
async function ownSpeechOrRefused(
  deps: SpokenBriefingDeps,
  run: Run,
  signal: AbortSignal,
): Promise<OwnSpeech | null> {
  try {
    return await ownSpeech(deps, run, signal);
  } catch (error) {
    // Lasting until the owner fixes the connection: no retry.
    if (!(error instanceof VoiceAccountError)) throw error;
    textOnly(run.id, "voice account", error);
    return null;
  }
}

/** The script, its transient failures tried again; null, logged, once the tries are used up. */
async function scriptOrNone(
  write: () => Promise<BriefingLine[] | null>,
  options: Parameters<typeof retry>[1],
  runId: string,
): Promise<BriefingLine[] | null> {
  try {
    return await retry(write, options);
  } catch (error) {
    textOnly(runId, "script", error);
    return null;
  }
}

async function make(deps: SpokenBriefingDeps, work: SpokenBriefingWork, signal: AbortSignal) {
  const { prisma, artifacts } = deps;
  // The routine may be gone (a one-time routine is deleted when its run completes): the run and
  // the co-host the job carries are all a briefing reads.
  const run = await prisma.run.findFirst({
    where: { id: work.runId, status: "completed" },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      threadId: true,
      thread: { select: { groupId: true } },
    },
  });
  if (!run || !artifacts || work.coHostBotId === run.botId) return;
  const done = await prisma.message.findFirst({
    where: { threadId: run.threadId, clientNonce: briefingNonce(run.id) },
    select: { id: true },
  });
  if (done) return;
  // Both bots as they are now: still the run owner's, in its Space, not archived. Only the
  // co-host's persona and voice are read, never its memory or its chats.
  const ownBot = (id: string) =>
    prisma.bot.findFirst({
      where: { id, spaceId: run.spaceId, userId: run.userId, archivedAt: null },
      select: { id: true, name: true, description: true, instructions: true, voiceId: true },
    });
  const [host, coHost] = await Promise.all([ownBot(run.botId), ownBot(work.coHostBotId)]);
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
  const speech = await ownSpeechOrRefused(deps, run, signal);
  if (!speech) return;
  const delayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
  const lines = await scriptOrNone(
    () =>
      writeScript(
        deps,
        run,
        spokenBriefingPrompt({ host: persona(host), coHost: persona(coHost), result }),
        signal,
      ),
    { attempts: CALL_ATTEMPTS, delayMs, signal, retryable: transientModel },
    run.id,
  );
  if (!lines?.length) return textOnly(run.id, "no script");
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
    try {
      clips.push(
        await retry(
          () =>
            speech.provider.synthesize(
              {
                text: line.text,
                voiceId: line.speaker === "A" ? host.voiceId! : coHost.voiceId!,
                apiKey: speech.apiKey,
                model: speech.model,
                signal: deadlineSignal(LINE_TIMEOUT_MS, signal),
              },
              context,
            ),
          { attempts: CALL_ATTEMPTS, delayMs, signal, retryable: transientSpeech },
        ),
      );
    } catch (error) {
      // An account the provider refuses, an address it may not reach, a voice it lacks: lasting.
      return textOnly(run.id, "speech", error);
    }
  }
  const audio = joinSpeechClips(clips);
  if (!audio) return textOnly(run.id, "clips do not join");
  if (audio.bytes.byteLength > (deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES))
    return textOnly(run.id, "too large");
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
 * The briefing started at once: once it is posted or ended with the text only, its backup job
 * goes; a failure outside the model and speech calls moves the job to now, for the queue's retry.
 */
async function startNow(
  deps: SpokenBriefingDeps,
  jobs: Pick<JobPublisher, "enqueue" | "cancel">,
  work: SpokenBriefingWork,
) {
  try {
    await makeSpokenBriefing(deps, work);
  } catch (error) {
    if (error instanceof LeaseHeldError) return;
    await jobs.enqueue(spokenBriefingJob(work, new Date()));
    throw error;
  }
  await jobs.cancel(spokenBriefingJobKey(work.runId));
}

const begin = (work: () => Promise<unknown>) => {
  void bestEffort("spoken briefing", work());
};

/**
 * Called first thing after a run's completion commits, before the routine can be deleted (a
 * one-time routine is, with its briefing row). A routine run takes one of its routine's briefings
 * of the day and, in the same transaction, records the briefing's backup job with its co-host;
 * then the briefing starts in this process. Every other run costs nothing. Never fails the run.
 */
export async function dozoSpokenBriefingAfterRun(ctx: RunContext, start = begin): Promise<void> {
  const { deps, run } = ctx;
  const routineId = run.trigger === "routine" ? run.routineId : null;
  if (!routineId) return;
  await bestEffort(
    "spoken briefing",
    (async () => {
      const work = await deps.prisma.$transaction(async (tx) => {
        const coHostBotId = await takeSpokenBriefing(tx, routineId);
        if (!coHostBotId) return null;
        const taken = { runId: run.id, coHostBotId };
        await deps.jobs.enqueueIn(
          tx,
          spokenBriefingJob(taken, new Date(Date.now() + BRIEFING_BACKUP_MS)),
        );
        return taken;
      });
      if (!work) return;
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
      start(() => startNow(briefingDeps, deps.jobs, work));
    })(),
  );
}

/** The briefing's job: the backup of one started at once, or the retry of one that failed. */
export function dozoSpokenBriefingJob(
  deps: Omit<SpokenBriefingDeps, "resolveModel" | "allowPrivateEndpoint"> & {
    executor: { resolveModel: SpokenBriefingDeps["resolveModel"] };
  },
) {
  return async (work: SpokenBriefingWork) => {
    const owner = await runAsSystem("find the run a spoken briefing is for", () =>
      deps.prisma.run.findUnique({
        where: { id: work.runId },
        select: { spaceId: true, userId: true },
      }),
    );
    if (!owner) return;
    try {
      await runAsTenant(owner, () =>
        makeSpokenBriefing({ ...deps, resolveModel: deps.executor.resolveModel }, work),
      );
    } catch (error) {
      if (error instanceof LeaseHeldError) throw new RetryJobLaterError(HELD_RETRY_MS);
      throw error;
    }
  };
}
