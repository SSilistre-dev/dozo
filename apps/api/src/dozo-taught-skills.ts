import { SandboxAllowanceUsedError } from "@rakazo/adapter-kit";
import {
  emptyRecording,
  parsePlaybook,
  parseRecording,
  sandboxAllowanceUsedUp,
} from "@rakazo/adapters";
import type { Actor, DozoTeachValueDecision, SkillPlaybook } from "@rakazo/contracts";
import { TeachRecordingSchema } from "@rakazo/contracts";
import type { TeachClickTarget, TeachRecordingEvent } from "@rakazo/core";
import {
  applyValueDecisions,
  ClientError,
  clicksBeforeSecrets,
  forgetTeachTyping,
  savedSkillLiterals,
  teachTypingForgotten,
  withClickTargets,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  IsolationError,
  JsonColumnMismatchError,
  readJsonColumn,
  reportJsonColumnOnce,
  storedMessageBlocks,
  storedTeachTargets,
  takeTeachValues,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import * as z from "zod";
import type { TaughtSkillsDeps } from "./taught-skills.js";
import { createTaughtSkillsService as createUpstreamTaughtSkillsService } from "./taught-skills.js";

/** How many of a thread's latest bot messages are looked through for a skill's card. */
const CARD_MESSAGES = 100;

const CardEventPayload = z
  .object({ messageId: z.string(), blocks: z.array(z.unknown()) })
  .passthrough()
  .nullable();

/**
 * The thread's earlier updates of a skill's card hold the steps as they were. Once its steps no
 * longer type text verbatim, those copies are brought to the new steps too, in the caller's
 * transaction, so the text is left nowhere in the thread's history. A payload in another shape
 * is left as it is.
 */
async function rewriteCardEvents(
  tx: Prisma.TransactionClient,
  skill: { id: string; botId: string },
  playbook: SkillPlaybook,
) {
  const bot = await tx.bot.findUnique({ where: { id: skill.botId }, include: { thread: true } });
  if (!bot?.thread) return;
  const threadId = bot.thread.id;
  const messages = await tx.message.findMany({
    where: { threadId, role: "bot" },
    orderBy: { seq: "desc" },
    take: CARD_MESSAGES,
  });
  const cards = messages.flatMap((message) =>
    storedMessageBlocks(message).some(
      (block) => block.kind === "skill_draft" && block.skillId === skill.id,
    )
      ? [message.id]
      : [],
  );
  if (!cards.length) return;
  // The message id stays plain in a sealed payload, so it can be looked up.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM events WHERE "threadId" = ${threadId} AND payload->>'messageId' = ANY(${cards})`;
  const events = await tx.event.findMany({ where: { id: { in: rows.map((row) => row.id) } } });
  for (const event of events) {
    const payload = readJsonColumn(
      CardEventPayload,
      event.payload,
      { table: "events", column: "payload", id: event.id },
      { fallback: null },
    );
    if (!payload) continue;
    const blocks = payload.blocks.map((block) => {
      const card = SkillCard.safeParse(block);
      return card.success && card.data.skillId === skill.id ? { ...card.data, playbook } : block;
    });
    await tx.event.update({
      where: { id: event.id },
      data: { payload: { ...payload, blocks } as never },
    });
  }
}

const SkillCard = z.object({ kind: z.literal("skill_draft"), skillId: z.string() }).passthrough();

/** A save or test of a skill whose stored recording is not in its shape. */
export const TEACH_RECORDING_UNREADABLE = "teach_recording_unreadable";

/**
 * A skill's recording, checked against its schema before anything walks its events: one in
 * another shape is a refusal the person can act on (teach the skill again), not a server error.
 */
export function teachRecordingOf(skill: { id: string; recording: unknown }) {
  const row = { table: "taught_skills", column: "recording", id: skill.id };
  try {
    // Checked item by item; the parse below keeps what the schema would strip (`typed`).
    readJsonColumn(TeachRecordingSchema, skill.recording, row, "reject");
  } catch (error) {
    if (!(error instanceof JsonColumnMismatchError)) throw error;
    throw new ClientError(
      "CONFLICT",
      "This skill's recording cannot be read. Teach it again.",
      TEACH_RECORDING_UNREADABLE,
    );
  }
  return parseRecording(skill.recording);
}

/** A decision about a saved skill's values made on steps that changed since they were read. */
export const SKILL_CHANGED = "skill_changed";

/** A save or test that decides about values of a skill no longer a draft. */
export const SKILL_NOT_DRAFT = "skill_not_draft";

/** The draft as the card sends it, and the teacher's decision for each value typed. */
export type TeachSaveEdit = {
  playbook: SkillPlaybook;
  decisions: Record<string, DozoTeachValueDecision>;
  /** Ids of the clicks whose picture the teacher removed: their steps keep the coordinate. */
  removedTargets?: string[];
  /** What the model saw each kept click hit, by click id, made before the save. */
  labels?: Record<string, string>;
};

/** A recorded click's id: the index of its event in the drafted recording. */
export const teachTargetId = (eventIndex: number) => String(eventIndex);

/**
 * The clicks whose step may say what they hit: not removed by the teacher, and not followed by
 * a hidden value (protected input, or one the teacher chose Hidden for), whose picture, label
 * and window are never kept. Each with its window and, when given, its label.
 */
export function keptTeachClicks(
  skillId: string,
  recording: unknown,
  events: TeachRecordingEvent[],
  edit: Pick<TeachSaveEdit, "decisions" | "removedTargets" | "labels">,
): TeachClickTarget[] {
  const hidden = Object.entries(edit.decisions).flatMap(([placeholder, decision]) =>
    decision.action === "hidden" ? [placeholder] : [],
  );
  const secret = clicksBeforeSecrets(events, hidden);
  const removed = new Set(edit.removedTargets ?? []);
  return storedTeachTargets(skillId, recording).flatMap((target) => {
    const id = teachTargetId(target.eventIndex);
    if (removed.has(id) || secret.has(target.eventIndex)) return [];
    const label = edit.labels?.[id];
    return [
      {
        eventIndex: target.eventIndex,
        ...(target.window ? { window: target.window } : {}),
        ...(label ? { label } : {}),
      },
    ];
  });
}

/** Skills one pass of `forgetOldTeachTyping` looks at. */
export const FORGET_PAGE = 100;

/**
 * Forgets what was typed in skills whose recording still holds it: ones the previous release
 * drafted or saved while this one was being deployed (and any the migration did not reach). As a
 * draft does, each typed run becomes one event and each window title its application; their
 * values are gone for good, so their review shows none. A live recording is left alone. Called
 * where skills are read and by the API's slow sweep, which pages on with `after`: skills are
 * looked at in id order, `FORGET_PAGE` at a time. A recording not in its stored shape is reported
 * and left as it is, so it holds back neither the read nor the skills after it. Returns how many
 * skills it looked at and the last one's id.
 */
export async function forgetOldTeachTyping(
  prisma: PrismaClient,
  scope: { spaceId?: string; botId?: string; skillId?: string; after?: string },
): Promise<{ looked: number; last: string | null }> {
  const { spaceId = null, botId = null, skillId = null, after = null } = scope;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM taught_skills
    WHERE status <> 'recording'
      AND (${skillId}::text IS NULL OR id = ${skillId}::text)
      AND (${spaceId}::text IS NULL OR "spaceId" = ${spaceId}::text)
      AND (${botId}::text IS NULL OR "botId" = ${botId}::text)
      AND (${after}::text IS NULL OR id > ${after}::text)
      AND COALESCE(recording->'dozoScrubbed', 'false'::jsonb) <> 'true'::jsonb
      AND ((jsonb_typeof(recording->'events') = 'array'
          AND jsonb_array_length(recording->'events') > 0)
        OR (jsonb_typeof(recording->'snapshots') = 'array'
          AND jsonb_array_length(recording->'snapshots') > 0))
    ORDER BY id
    LIMIT ${FORGET_PAGE}`;
  for (const { id } of rows) {
    const row = { table: "taught_skills", column: "recording", id };
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${id} FOR UPDATE`;
        const skill = await tx.taughtSkill.findUnique({ where: { id } });
        if (!skill || skill.status === "recording" || teachTypingForgotten(skill.recording)) return;
        // Checked item by item; the parse below keeps what the schema would strip (`typed`).
        readJsonColumn(TeachRecordingSchema, skill.recording, row, "reject");
        const recording = forgetTeachTyping(parseRecording(skill.recording), false);
        // In SQL, so the skill keeps its place in the list (ordered by its last edit).
        await tx.$executeRaw`
          UPDATE taught_skills SET recording = ${JSON.stringify(recording)}::jsonb WHERE id = ${id}`;
      });
    } catch (error) {
      if (!(error instanceof JsonColumnMismatchError)) throw error;
      reportJsonColumnOnce("A taught skill's recording cannot have its typing forgotten", row);
    }
  }
  return { looked: rows.length, last: rows.at(-1)?.id ?? null };
}

/** Reading skills forgets old typing first, and still reads when that fails. */
function forgetBeforeReading(
  prisma: PrismaClient,
  scope: Parameters<typeof forgetOldTeachTyping>[1],
) {
  return bestEffort("forget old typing before reading skills", forgetOldTeachTyping(prisma, scope));
}

/**
 * Upstream's taught-skills service under the same name, with three changes: reading skills first
 * forgets what is typed in any the previous release left with it (`forgetOldTeachTyping`),
 * teaching on a plan with no computer time left is refused before any of the person's runs is
 * cancelled, and every save, in one transaction, applies the teacher's decisions to the values
 * typed, says in each kept click's step what it hit, forgets the values and the clicks'
 * pictures, and keeps nothing typed or clicked in the recording.
 */
export function createTaughtSkillsService(deps: TaughtSkillsDeps) {
  const upstream = createUpstreamTaughtSkillsService(deps);
  return {
    ...upstream,

    async list(actor: Actor, botId: string) {
      await forgetBeforeReading(deps.prisma, { spaceId: actor.spaceId, botId });
      return upstream.list(actor, botId);
    },

    async get(actor: Actor, skillId: string) {
      await forgetBeforeReading(deps.prisma, { spaceId: actor.spaceId, skillId });
      return upstream.get(actor, skillId);
    },

    async start(actor: Actor, botId: string, goal: string) {
      const bot = await deps.prisma.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId },
        include: { computer: true },
      });
      const computer = bot?.computer;
      // Only a computer teaching would start; a running one costs nothing new.
      if (computer && (computer.state !== "running" || !computer.providerRef)) {
        const kind = (await deps.sandbox.provisionKind?.(computer.homeKey)) ?? computer.kind;
        if (await sandboxAllowanceUsedUp(deps, { spaceId: computer.spaceId, kind })) {
          throw new SandboxAllowanceUsedError();
        }
      }
      return upstream.start(actor, botId, goal);
    },

    /**
     * Saves the skill. Only the person who taught a draft decides about its values (anyone else
     * sends none, and upstream's rules apply); a value with no decision becomes an input. The
     * card and the thread follow the commit and carry only placeholders, names and the text the
     * teacher chose to keep.
     */
    async save(actor: Actor, skillId: string, name?: string, edit?: TeachSaveEdit) {
      const decisions = edit?.decisions ?? {};
      const decides = Object.keys(decisions).length > 0;
      const row = await deps.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM taught_skills WHERE id = ${skillId} AND "spaceId" = ${actor.spaceId}
          FOR UPDATE`;
        const skill = await tx.taughtSkill.findFirst({
          where: { id: skillId, spaceId: actor.spaceId },
        });
        if (!skill) throw new IsolationError();
        if (skill.status !== "draft" && skill.status !== "saved") {
          throw new ClientError("BAD_REQUEST", "Finish recording before saving");
        }
        const teacher = skill.userId === actor.userId;
        if (decides && !teacher) {
          throw new ClientError(
            "FORBIDDEN",
            "Only the person who taught this skill can decide about its values",
          );
        }
        // The values are forgotten once saved: the decisions would apply to nothing.
        if (decides && skill.status !== "draft") {
          throw new ClientError("CONFLICT", "This skill is already saved", SKILL_NOT_DRAFT);
        }
        const stored = await takeTeachValues(tx, skill.id);
        const values =
          teacher && skill.status === "draft" && stored?.userId === actor.userId
            ? stored.values
            : [];
        const playbook = edit?.playbook ?? parsePlaybook(skill.playbook);
        // Someone else gets the skill without the recording, so only the teacher's is read.
        const recording = teacher ? teachRecordingOf(skill) : emptyRecording();
        const decided = values.length ? applyValueDecisions(playbook, values, decisions) : playbook;
        // Upstream's parse keeps only its own keys: the clicks' windows are gone with it.
        const clicks =
          teacher && skill.status === "draft"
            ? keptTeachClicks(skill.id, skill.recording, recording.events, {
                ...edit,
                decisions,
              })
            : [];
        return tx.taughtSkill.update({
          where: { id: skill.id },
          data: {
            userId: actor.userId,
            // Someone else takes the skill over without the recording, as upstream hands it over.
            recording: (teacher
              ? forgetTeachTyping(recording, teachTypingForgotten(skill.recording))
              : emptyRecording()) as never,
            status: "saved",
            name: name ?? (skill.name || skill.goal.slice(0, 80)),
            playbook: (clicks.length
              ? withClickTargets(decided, recording.events, clicks)
              : decided) as never,
          },
        });
      });
      // Upstream's edit of a saved skill rewrites the same fields and updates the draft card.
      const saved = await upstream.updateDraft(actor, skillId, {
        name: row.name,
        playbook: parsePlaybook(row.playbook),
      });
      const bot = await deps.prisma.bot.findUnique({
        where: { id: row.botId },
        include: { thread: true },
      });
      if (bot?.thread) {
        await deps.events.append({
          spaceId: actor.spaceId,
          threadId: bot.thread.id,
          botId: bot.id,
          type: "skill.saved",
          payload: { skillId: row.id, name: row.name },
        });
      }
      return saved;
    },

    /**
     * Decides about the values a skill saved by an older release keeps verbatim in its steps,
     * as the teacher of a draft does: an input, a hidden input, text kept as typed, or removed.
     * Whoever may edit the skill may (any member of the Space, who then owns it, as upstream's
     * edit does); its steps are already shown to all of them. `steps` are those the person saw:
     * a skill changed since is refused, so no decision lands on another value. One transaction
     * writes the steps and forgets anything typed left in the recording; the draft card follows
     * the commit with what was saved.
     */
    async decideSavedValues(
      actor: Actor,
      skillId: string,
      input: { steps: string[]; decisions: Record<string, DozoTeachValueDecision> },
    ) {
      const row = await deps.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM taught_skills WHERE id = ${skillId} AND "spaceId" = ${actor.spaceId}
          FOR UPDATE`;
        const skill = await tx.taughtSkill.findFirst({
          where: { id: skillId, spaceId: actor.spaceId },
        });
        if (!skill) throw new IsolationError();
        if (skill.status !== "saved") {
          throw new ClientError("BAD_REQUEST", "Only a saved skill's steps are decided here");
        }
        const playbook = parsePlaybook(skill.playbook);
        if (JSON.stringify(playbook.steps) !== JSON.stringify(input.steps)) {
          throw new ClientError("CONFLICT", "This skill changed. Open it again.", SKILL_CHANGED);
        }
        const literals = savedSkillLiterals(playbook);
        const teacher = skill.userId === actor.userId;
        const decided = applyValueDecisions(literals.playbook, literals.values, input.decisions);
        await rewriteCardEvents(tx, skill, decided);
        return tx.taughtSkill.update({
          where: { id: skill.id },
          data: {
            userId: actor.userId,
            recording: (teacher
              ? forgetTeachTyping(teachRecordingOf(skill), teachTypingForgotten(skill.recording))
              : emptyRecording()) as never,
            playbook: decided as never,
          },
        });
      });
      return upstream.updateDraft(actor, skillId, {
        name: row.name,
        playbook: parsePlaybook(row.playbook),
      });
    },
  };
}
