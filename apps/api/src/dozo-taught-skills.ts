import { SandboxAllowanceUsedError } from "@rakazo/adapter-kit";
import {
  emptyRecording,
  parsePlaybook,
  parseRecording,
  sandboxAllowanceUsedUp,
} from "@rakazo/adapters";
import type { Actor, DozoTeachValueDecision, SkillPlaybook } from "@rakazo/contracts";
import {
  applyValueDecisions,
  ClientError,
  forgetTeachTyping,
  teachTypingForgotten,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, takeTeachValues } from "@rakazo/db";
import type { TaughtSkillsDeps } from "./taught-skills.js";
import { createTaughtSkillsService as createUpstreamTaughtSkillsService } from "./taught-skills.js";

/** A save or test that decides about values of a skill no longer a draft. */
export const SKILL_NOT_DRAFT = "skill_not_draft";

/** The draft as the card sends it, and the teacher's decision for each value typed. */
export type TeachSaveEdit = {
  playbook: SkillPlaybook;
  decisions: Record<string, DozoTeachValueDecision>;
};

/** Skills one pass of `forgetOldTeachTyping` looks at. */
export const FORGET_PAGE = 100;

/**
 * Forgets what was typed in skills whose recording still holds it: ones the previous release
 * drafted or saved while this one was being deployed (and any the migration did not reach). As a
 * draft does, each typed run becomes one event and each window title its application; their
 * values are gone for good, so their review shows none. A live recording is left alone. Called
 * where skills are read and by the API's slow sweep; the number of skills it looked at.
 */
export async function forgetOldTeachTyping(
  prisma: PrismaClient,
  scope: { spaceId?: string; botId?: string; skillId?: string },
): Promise<number> {
  const { spaceId = null, botId = null, skillId = null } = scope;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM taught_skills
    WHERE status <> 'recording'
      AND (${skillId}::text IS NULL OR id = ${skillId}::text)
      AND (${spaceId}::text IS NULL OR "spaceId" = ${spaceId}::text)
      AND (${botId}::text IS NULL OR "botId" = ${botId}::text)
      AND COALESCE(recording->'dozoScrubbed', 'false'::jsonb) <> 'true'::jsonb
      AND ((jsonb_typeof(recording->'events') = 'array'
          AND jsonb_array_length(recording->'events') > 0)
        OR (jsonb_typeof(recording->'snapshots') = 'array'
          AND jsonb_array_length(recording->'snapshots') > 0))
    LIMIT ${FORGET_PAGE}`;
  for (const { id } of rows) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${id} FOR UPDATE`;
      const skill = await tx.taughtSkill.findUnique({ where: { id } });
      if (!skill || skill.status === "recording" || teachTypingForgotten(skill.recording)) return;
      const recording = forgetTeachTyping(parseRecording(skill.recording), false);
      // In SQL, so the skill keeps its place in the list (ordered by its last edit).
      await tx.$executeRaw`
        UPDATE taught_skills SET recording = ${JSON.stringify(recording)}::jsonb WHERE id = ${id}`;
    });
  }
  return rows.length;
}

/**
 * Upstream's taught-skills service under the same name, with three changes: reading skills first
 * forgets what is typed in any the previous release left with it (`forgetOldTeachTyping`),
 * teaching on a plan with no computer time left is refused before any of the person's runs is
 * cancelled, and every save, in one transaction, applies the teacher's decisions to the values
 * typed, forgets those values and keeps nothing typed in the recording.
 */
export function createTaughtSkillsService(deps: TaughtSkillsDeps) {
  const upstream = createUpstreamTaughtSkillsService(deps);
  return {
    ...upstream,

    async list(actor: Actor, botId: string) {
      await forgetOldTeachTyping(deps.prisma, { spaceId: actor.spaceId, botId });
      return upstream.list(actor, botId);
    },

    async get(actor: Actor, skillId: string) {
      await forgetOldTeachTyping(deps.prisma, { spaceId: actor.spaceId, skillId });
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
        const recording = parseRecording(skill.recording);
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
            playbook: (values.length
              ? applyValueDecisions(playbook, values, decisions)
              : playbook) as never,
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
  };
}
