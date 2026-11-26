import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  BackgroundJob,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { RetryJobLaterError } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { MEMORY_INDEX_PATH } from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  isPartialReplyClientNonce,
  LeaseHeldError,
  readMessageBlocks,
  recordUsage,
  runAsSystem,
  runAsTenant,
  withLease,
} from "@rakazo/db";
import type { CompactionModelSources } from "./dozo-compaction-model.js";
import { compactWithRoleModel } from "./dozo-compaction-model.js";
import type { DozoLearningMemory, LearningEvents } from "./dozo-learning-apply.js";
import {
  learningChanged,
  linesOf,
  parseLearningReply,
  saveLearnedNotes,
  settleLeftLearningWrites,
} from "./dozo-learning-apply.js";
import type { LearningTranscriptLine } from "./dozo-learning-review.prompt.js";
import { learningReviewInstructions, learningReviewPrompt } from "./dozo-learning-review.prompt.js";
import { knownSkillNames, suggestLearnedSkill } from "./dozo-learning-skill.js";
import type { LearningTurn } from "./dozo-learning-store.js";
import {
  consumeLearningTurns,
  dropLearningTurns,
  learnedLines,
  learningMode,
  pendingLearningTurns,
  rejectedLearningLines,
  rejectedLearningSkills,
  takeLearningReview,
} from "./dozo-learning-store.js";
import { onlyOwnerReads } from "./dozo-phone.js";
import type { RunRedactionDeps } from "./dozo-run-redactions.js";
import { loadRunRedactions } from "./dozo-run-redactions.js";
import { HostedModelCreditsRequiredError } from "./models/credits/model-credit-observer.js";
import { redactBlocks } from "./runs/assembly/run-messages.js";
import { messageBlocksText } from "./runs/assembly/run-replies.prompt.js";
import { isUserProgressClientNonce } from "./runs/lifecycle/user-progress.js";

/** A review starts at once when this many of the owner's turns wait. */
export const LEARNING_REVIEW_BATCH = 10;
/** Fewer wait for a pause this long after the owner's last turn. */
export const LEARNING_IDLE_MS = 15 * 60_000;
/** Fewer than this many waiting turns are not worth a model call: they wait for more. */
export const LEARNING_REVIEW_MIN_TURNS = 3;
/** One review's model call may take this long. */
export const LEARNING_REVIEW_TIMEOUT_MS = 90_000;
/**
 * A review started at once has a backup job due once its attempt is surely over: the role
 * model's call, the bot's own model after it fails, then reading and saving.
 */
export const LEARNING_REVIEW_BACKUP_MS = 2 * LEARNING_REVIEW_TIMEOUT_MS + 3 * 60_000;
/**
 * Tries of the review job, its queue's backoff between them: a model that keeps failing stops
 * being asked, and the turns wait for the owner's next one.
 */
export const LEARNING_REVIEW_MAX_ATTEMPTS = 4;
/** A job that finds another process reviewing the bot looks again this much later. */
const HELD_RETRY_MS = 2 * 60_000;
/** What one review reads of the conversation, newest kept. */
const TRANSCRIPT_MAX_CHARS = 16_000;
/** An owner message longer than this is likely pasted text, not the owner's own words: left out. */
export const LEARNING_OWNER_MESSAGE_MAX_CHARS = 2_000;
/** The most waiting turns one review reads; older ones are dropped with them. */
const TURNS_READ = 100;
/** The latest lines the owner turned down that the model is told not to suggest again. */
const REJECTED_SHOWN = 20;
const LEASE_TTL_MS = 60_000;

type Bot = { id: string; spaceId: string; userId: string };
type Model = AgentRunRequest["model"];

export type LearningReviewDeps = RunRedactionDeps & {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  memory: DozoLearningMemory;
  /** The bot's own model, which a review falls back to as compaction does. */
  resolveModel: (scope: { userId: string; spaceId: string; botId?: string }) => Promise<Model>;
  resolveConnectedModel: CompactionModelSources["resolveConnectedModel"];
  /**
   * Tells the owner's apps that the notes changed (learningChanged), and publishes a suggested
   * skill's card in the bot's chat.
   */
  events: LearningEvents & Pick<ThreadEvents, "notify">;
};

/**
 * Whether the bot may learn: nobody but its owner is a member or guest of its Space, the rule the
 * phone tools follow. A Space's members read its bots' notes and chats.
 */
export function learningAvailable(
  prisma: Pick<PrismaClient, "spaceMember">,
  bot: { spaceId: string; userId: string },
): Promise<boolean> {
  return onlyOwnerReads(prisma, { spaceId: bot.spaceId }, bot.userId);
}

export const learningReviewJobKey = (botId: string) => `learning.review:${botId}`;

/** The bot's one review job: the backup of a review under way, or the wait for a pause. */
export function learningReviewJob(botId: string, availableAt: Date): BackgroundJob {
  return {
    name: "memory.learning-review",
    payload: { botId },
    availableAt,
    replaceKey: learningReviewJobKey(botId),
    maxAttempts: LEARNING_REVIEW_MAX_ATTEMPTS,
  };
}

/** A card that asked for a secret or a code is left out with its message. */
const asksSecret = (blocks: MessageBlock[]) =>
  blocks.some(
    (block) => block.kind === "ask" && (block.input === "secret" || Boolean(block.oneTimeCode)),
  );

/**
 * A message's text with every saved value hidden as a run hides it. A message whose blocks cannot
 * all be read is left out: a missing block could have been the one that made it private.
 */
function textOf(message: { id: string; blocks: unknown }, secrets: string[]): string {
  const { blocks, intact } = readMessageBlocks(message);
  if (!intact || asksSecret(blocks)) return "";
  return messageBlocksText(redactBlocks(blocks, secrets)).trim();
}

/** The values the turns' runs hid, loaded as a run loads them (loadRunRedactions). */
async function hiddenValues(deps: LearningReviewDeps, bot: Bot, turns: LearningTurn[]) {
  const scope = { userId: bot.userId, spaceId: bot.spaceId, botId: bot.id };
  const runIds = [...new Set(turns.map((turn) => turn.runId))];
  const { commands, saved } = await loadRunRedactions(deps, scope, runIds);
  return [...commands.redactions, ...saved];
}

/**
 * Each turn as the review reads it: the owner's own words, and for a turn whose reply is
 * readable (botReplyReadable), the bot's final reply. A turn whose message is too long to be
 * the owner's own words is left out whole. Oldest first, newest kept within the cap.
 */
export async function learningTranscript(
  prisma: Pick<PrismaClient, "message">,
  owner: string,
  turns: LearningTurn[],
  secrets: string[],
): Promise<LearningTranscriptLine[][]> {
  const [sources, replies] = await Promise.all([
    prisma.message.findMany({
      where: {
        id: { in: turns.map((turn) => turn.messageId) },
        role: "user",
        OR: [{ authorUserId: owner }, { authorUserId: null }],
      },
      select: { id: true, blocks: true },
    }),
    prisma.message.findMany({
      where: {
        runId: {
          in: turns.filter((turn) => turn.botReplyReadable === true).map((turn) => turn.runId),
        },
        role: "bot",
      },
      orderBy: { seq: "asc" },
      select: { id: true, runId: true, blocks: true, clientNonce: true },
    }),
  ]);
  const said = new Map(sources.map((message) => [message.id, textOf(message, secrets)]));
  const finalReply = new Map<string, string>();
  for (const reply of replies) {
    if (isPartialReplyClientNonce(reply.clientNonce)) continue;
    if (isUserProgressClientNonce(reply.clientNonce)) continue;
    const text = textOf(reply, secrets);
    if (reply.runId && text) finalReply.set(reply.runId, text);
  }
  const kept: LearningTranscriptLine[][] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    const owned = said.get(turn.messageId);
    if (!owned || owned.length > LEARNING_OWNER_MESSAGE_MAX_CHARS) continue;
    const lines: LearningTranscriptLine[] = [{ speaker: "owner", text: owned }];
    // Only a readable turn's replies were read.
    const reply = finalReply.get(turn.runId);
    if (reply) lines.push({ speaker: "bot", text: reply });
    const size = lines.reduce((sum, line) => sum + line.text.length, 0);
    if (used + size > TRANSCRIPT_MAX_CHARS) {
      if (!kept.length) kept.push([lines[0]!]);
      break;
    }
    used += size;
    kept.push(lines);
  }
  return kept.reverse();
}

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;

/**
 * The runtime's own failure text, as compaction reads it: a transient error, tried again. It
 * depends on the runtime's wording (pi-runtime-errors.ts).
 */
const RUNTIME_FAILURE = /^(?:I hit a problem:|Unknown model )/i;

/**
 * One tool-less call on the member's compaction role model, falling back to the bot's own model
 * as compaction does, and only while the bot has a review of the day left. Usage is recorded as
 * setup under the bot. A failed call, the runtime's own failure text and an empty answer throw, so
 * the turns wait for another try. Null without a call: no model that can answer (none connected,
 * or the hosted one without credits) or no review left today; the turns wait.
 */
async function askReviewModel(
  deps: LearningReviewDeps,
  bot: Bot,
  operationId: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string | null> {
  const scope = { userId: bot.userId, spaceId: bot.spaceId, botId: bot.id };
  const record = async (event: UsageEvent) => {
    await recordUsage(deps.prisma, event, { ...scope, operationId, operationKind: "setup" });
  };
  let answer: string | null = null;
  let counted = false;
  try {
    await compactWithRoleModel(deps.prisma, deps, async (resolveModel) => {
      const model = await (resolveModel ?? deps.resolveModel)(scope);
      answer = null;
      if (!deps.runtime.describe().capabilities.compaction || model.provider === "scripted") return;
      if (!counted && !(await takeLearningReview(deps.prisma, bot))) return;
      counted = true;
      let text = "";
      let failed = false;
      for await (const event of deps.runtime.run(
        {
          botId: bot.id,
          threadId: operationId,
          runId: operationId,
          usageOperationKind: "setup",
          onUsage: record,
          prompt,
          instructions: learningReviewInstructions(),
          history: [],
          tools: [],
          model: { ...model, thinkingLevel: "off" },
          allowSilentEmpty: true,
        },
        {
          operationId,
          traceId: operationId,
          ...scope,
          signal: deadlineSignal(LEARNING_REVIEW_TIMEOUT_MS, signal),
        },
      )) {
        if (event.type === "usage" && !event.accounted) await record(event);
        if (event.type === "text" && RUNTIME_FAILURE.test(event.text.trim())) failed = true;
        if (event.type === "done" && event.text) text = event.text.trim();
      }
      if (failed || RUNTIME_FAILURE.test(text))
        throw new Error("learning review model call failed");
      if (!text) throw new Error("learning review model answered nothing");
      answer = text;
    });
  } catch (error) {
    // The check every hosted model call makes: without credits nothing is asked, nor again.
    if (error instanceof HostedModelCreditsRequiredError) return null;
    throw error;
  }
  return answer;
}

/** The review's own lines in the notes, newest change first, each once, with short ids. */
async function ownLines(prisma: PrismaClient, botId: string, content: string) {
  const lines = new Set(linesOf(content));
  const own = new Map<string, string>();
  const seen = new Set<string>();
  for (const learned of await learnedLines(prisma, botId)) {
    if (!lines.has(learned.after) || seen.has(learned.after)) continue;
    seen.add(learned.after);
    own.set(`n${own.size + 1}`, learned.after);
  }
  return own;
}

const memoryContext = (bot: Bot, signal: AbortSignal) => ({
  operationId: `learning:${bot.id}`,
  traceId: `learning:${bot.id}`,
  spaceId: bot.spaceId,
  userId: bot.userId,
  botId: bot.id,
  signal,
});

async function review(deps: LearningReviewDeps, bot: Bot, signal: AbortSignal): Promise<void> {
  // Holding the bot's lease: a review's write left pending was cut short.
  await settleLeftLearningWrites(deps.prisma, bot, true);
  const turns = await pendingLearningTurns(deps.prisma, bot.id, TURNS_READ);
  const first = turns[0];
  const newest = turns.at(-1);
  if (!first || !newest || turns.length < LEARNING_REVIEW_MIN_TURNS) return;
  // Another member or a guest joined: their Space's notes are not learned from the owner's chat.
  if (!(await learningAvailable(deps.prisma, bot))) return dropLearningTurns(deps.prisma, bot.id);
  const transcript = await learningTranscript(
    deps.prisma,
    bot.userId,
    turns,
    await hiddenValues(deps, bot, turns),
  );
  if (!transcript.length) return consumeLearningTurns(deps.prisma, bot.id, turns);
  const context = memoryContext(bot, signal);
  const [notes] = (
    await deps.memory.read({ scope: "bot", botId: bot.id, path: MEMORY_INDEX_PATH }, context)
  ).documents;
  const content = notes?.content ?? "";
  const [own, rejected, skills, rejectedSkills] = await Promise.all([
    ownLines(deps.prisma, bot.id, content),
    rejectedLearningLines(deps.prisma, bot.id),
    knownSkillNames(deps.prisma, bot),
    rejectedLearningSkills(deps.prisma, bot.id),
  ]);
  const yours = new Set(own.values());
  const prompt = learningReviewPrompt({
    transcript,
    yours: [...own].map(([id, text]) => ({ id, text })),
    owners: linesOf(content).filter((line) => line.trim() && !yours.has(line)),
    rejected: rejected.slice(0, REJECTED_SHOWN),
    skills,
    rejectedSkills: rejectedSkills.slice(0, REJECTED_SHOWN),
  });
  // A failed call keeps the turns: the job tries again.
  const answer = await askReviewModel(deps, bot, `learning:${bot.id}:${first.id}`, prompt, signal);
  // Nothing asked (no model that can answer, no review left today): the turns wait.
  if (answer === null) return;
  // Read again: the owner may have changed it while the model answered.
  const mode = await learningMode(deps.prisma, bot.id);
  // Turned off meanwhile: nothing is learned from these turns.
  if (mode === "off") return consumeLearningTurns(deps.prisma, bot.id, turns);
  // Another member or a guest joined while it answered: as above, the turns are dropped.
  if (!(await learningAvailable(deps.prisma, bot))) return dropLearningTurns(deps.prisma, bot.id);
  const reply = parseLearningReply(answer, new Set(own.keys()));
  // Only Auto writes notes; in Ask they are not even offered.
  if (mode === "auto" && reply?.ops.length) {
    const applied = await saveLearnedNotes(deps, bot, context, {
      ops: reply.ops,
      labels: own,
      rejected: new Set(rejected),
      source: { threadId: newest.threadId, messageId: newest.messageId },
    });
    if (applied.length) await learningChanged(deps.events, bot.userId);
  }
  // A skill joins what the bot follows: in every mode it waits for the owner's Save.
  if (reply?.skill) {
    await suggestLearnedSkill(deps, bot, reply.skill);
  }
  // An answer that broke the contract is not asked again for the same turns.
  await consumeLearningTurns(deps.prisma, bot.id, turns);
}

/**
 * Reviews the bot's waiting turns once, when its owner has learning on (Ask or Auto). One review
 * per bot runs at a time across processes: while another holds the bot, this one leaves the turns
 * to it and answers "held". Runs in the bot owner's tenant context.
 */
export async function reviewLearning(
  deps: LearningReviewDeps,
  botId: string,
): Promise<"held" | undefined> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId },
    select: { id: true, spaceId: true, userId: true },
  });
  if (!bot || (await learningMode(deps.prisma, botId)) === "off") return;
  try {
    await withLease(deps.prisma, `dozo-learning:${botId}`, { ttlMs: LEASE_TTL_MS }, (lease) =>
      review(deps, bot, lease.signal),
    );
  } catch (error) {
    if (!(error instanceof LeaseHeldError)) throw error;
    return "held";
  }
  return undefined;
}

/**
 * The job that runs a review (the backup of one under way, or the one after a pause), or only
 * settles an undo cut short (`settleOnly`).
 */
export function dozoLearningReviewJob(
  deps: RunRedactionDeps & {
    runtime: AgentRuntime;
    jobs: JobPublisher;
    events: LearningReviewDeps["events"];
    /** The bot notes' store; a worker built without one cannot review (the job fails). */
    memory?: DozoLearningMemory;
    executor: Pick<LearningReviewDeps, "resolveModel" | "resolveConnectedModel">;
  },
) {
  return async ({ botId, settleOnly }: { botId: string; settleOnly?: boolean }) => {
    const { memory } = deps;
    if (!memory) throw new Error("A learning review needs the memory store.");
    const owner = await runAsSystem("find the bot a learning review is for", () =>
      deps.prisma.bot.findUnique({ where: { id: botId }, select: { spaceId: true, userId: true } }),
    );
    if (!owner) return;
    const outcome = await runAsTenant(owner, async () => {
      await settleLeftLearningWrites(deps.prisma, { id: botId, spaceId: owner.spaceId }, false);
      if (settleOnly) return undefined;
      return reviewLearning(
        {
          prisma: deps.prisma,
          runtime: deps.runtime,
          memory,
          secretStore: deps.secretStore,
          paymentWallet: deps.paymentWallet,
          resolveModel: deps.executor.resolveModel,
          resolveConnectedModel: deps.executor.resolveConnectedModel,
          events: deps.events,
        },
        botId,
      );
    });
    // The review under way may still fail and leave the turns: look again once it is over.
    if (outcome === "held") throw new RetryJobLaterError(HELD_RETRY_MS);
  };
}
