import { SandboxAllowanceUsedError } from "@rakazo/adapter-kit";
import {
  emptyRecording,
  parsePlaybook,
  parseRecording,
  sandboxAllowanceUsedUp,
} from "@rakazo/adapters";
import type { Actor, DozoTeachValueDecision, SkillPlaybook } from "@rakazo/contracts";
import type { TeachClickTarget, TeachRecordingEvent } from "@rakazo/core";
import {
  applyValueDecisions,
  ClientError,
  clicksBeforeSecrets,
  scrubTeachEvents,
  withClickTargets,
} from "@rakazo/core";
import { IsolationError, storedTeachTargets, takeTeachValues } from "@rakazo/db";
import type { TaughtSkillsDeps } from "./taught-skills.js";
import { createTaughtSkillsService as createUpstreamTaughtSkillsService } from "./taught-skills.js";

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

/**
 * Upstream's taught-skills service under the same name, with two changes: teaching on a plan with
 * no computer time left is refused before any of the person's runs is cancelled, and every save,
 * in one transaction, applies the teacher's decisions to the values typed, says in each kept
 * click's step what it hit, forgets the values and the clicks' pictures, and keeps nothing typed
 * or clicked in the recording.
 */
export function createTaughtSkillsService(deps: TaughtSkillsDeps) {
  const upstream = createUpstreamTaughtSkillsService(deps);
  return {
    ...upstream,

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
              ? { ...recording, events: scrubTeachEvents(recording.events) }
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
  };
}
