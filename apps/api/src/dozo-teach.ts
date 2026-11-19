import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { parsePlaybook, parseRecording } from "@rakazo/adapters";
import type {
  Actor,
  DozoTeachTarget,
  DozoTeachValue,
  DozoTeachValueDecision,
  SkillPlaybook,
} from "@rakazo/contracts";
import type { TeachTypedValue } from "@rakazo/core";
import {
  applyValueDecisions,
  buildPlaybookFromRecording,
  ClientError,
  clickStepIndexes,
  formatSkillRunPrompt,
  teachWindowTitles,
  withClickTargets,
} from "@rakazo/core";
import type { PrismaClient, StoredTeachValues, TeachValueSuggestions } from "@rakazo/db";
import {
  cacheTeachSuggestions,
  IsolationError,
  readTeachValues,
  storedTeachTargets,
} from "@rakazo/db";
import type { createTaughtSkillsService } from "./dozo-taught-skills.js";
import { keptTeachClicks, SKILL_NOT_DRAFT, teachTargetId } from "./dozo-taught-skills.js";
import type { TeachClickLabeller } from "./dozo-teach-labels.js";
import { createTeachClickLabeller } from "./dozo-teach-labels.js";
import type { TeachValueSuggester } from "./dozo-teach-suggest.js";
import { createTeachValueSuggester, teachValueShape } from "./dozo-teach-suggest.js";
import type { RouterDeps } from "./router.js";
import type { RouterContext } from "./routes/context.js";

type TaughtSkills = Pick<
  ReturnType<typeof createTaughtSkillsService>,
  "updateDraft" | "save" | "testRun"
>;

export type DozoTeachInput = {
  skillId: string;
  name?: string;
  playbook: SkillPlaybook;
  decisions: Record<string, DozoTeachValueDecision>;
  removedTargets?: string[];
};

/** What the teach routes need from the server that the router's own dependencies do not carry. */
export interface DozoTeachWiring {
  /** Absent when the server has no model runtime to ask; the review then has no suggestions. */
  suggest?: TeachValueSuggester;
  /** Absent likewise; the clicks' steps then say only their window. */
  label?: TeachClickLabeller;
}

/** Spread into the router's dependencies where the server builds them. */
export function dozoTeachWiring(deps: {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  resolveModel: (scope: {
    userId: string;
    spaceId: string;
    botId: string;
  }) => Promise<AgentRunRequest["model"]>;
}): { dozoTeach: DozoTeachWiring } {
  return {
    dozoTeach: { suggest: createTeachValueSuggester(deps), label: createTeachClickLabeller(deps) },
  };
}

type Skill = {
  id: string;
  userId: string;
  botId: string;
  name: string;
  goal: string;
  status: string;
  playbook: unknown;
  recording: unknown;
};

/**
 * Reviewing what was typed and clicked while teaching, and saving or testing a draft with the
 * teacher's decision for each typed value and each click's picture. The values and pictures come
 * from the draft's short-lived store on the server, never from the client, and only the person
 * who taught the skill sees them or decides about them.
 */
export function createDozoTeach(deps: {
  prisma: PrismaClient;
  taughtSkills: TaughtSkills;
  suggest?: TeachValueSuggester;
  label?: TeachClickLabeller;
}) {
  async function skillOf(actor: Actor, skillId: string): Promise<Skill> {
    const skill = await deps.prisma.taughtSkill.findFirst({
      where: { id: skillId, spaceId: actor.spaceId },
    });
    if (!skill) throw new IsolationError();
    return skill;
  }

  /** The values of a draft, for the person who taught it and nobody else. */
  async function valuesFor(actor: Actor, skill: Skill): Promise<StoredTeachValues | null> {
    if (skill.userId !== actor.userId || skill.status !== "draft") return null;
    const stored = await readTeachValues(deps.prisma, skill.id);
    return stored?.userId === actor.userId ? stored : null;
  }

  /**
   * Asked once per draft, failed or not, and kept with the values. The model is told the task,
   * the recorded steps and each value's shape, never a value. Two first reviews at once may both
   * ask; the first to write is kept.
   */
  async function suggestionsFor(
    actor: Actor,
    skill: Skill,
    values: TeachTypedValue[],
  ): Promise<TeachValueSuggestions> {
    if (!deps.suggest) return {};
    const recording = parseRecording(skill.recording);
    const suggestions =
      (await deps.suggest(
        actor,
        {
          botId: skill.botId,
          goal: skill.goal,
          steps: buildPlaybookFromRecording(skill.goal, recording.events).steps,
          windowTitles: teachWindowTitles(recording.snapshots, values),
        },
        values.map(teachValueShape),
      )) ?? {};
    return (await cacheTeachSuggestions(deps.prisma, skill.id, suggestions)) ?? suggestions;
  }

  /** The clicks the teacher reviews: those whose step is still in the draft, with their picture. */
  function targetsFor(skill: Skill, stored: StoredTeachValues): DozoTeachTarget[] {
    const events = parseRecording(skill.recording).events;
    const indexes = clickStepIndexes(parsePlaybook(skill.playbook).steps, events);
    const images = new Map(stored.images.map((image) => [image.eventIndex, image.image]));
    return storedTeachTargets(skill.id, skill.recording).flatMap((target) => {
      const step = indexes.get(target.eventIndex);
      const image = images.get(target.eventIndex);
      if (step === undefined) return [];
      return [
        {
          id: teachTargetId(target.eventIndex),
          step,
          ...(target.window ? { window: target.window } : {}),
          ...(image ? { image: `data:image/webp;base64,${image}` } : {}),
        },
      ];
    });
  }

  /**
   * What the model saw each click the teacher kept hit, asked at the save and only then: never
   * for a removed picture, one whose step is gone, or one before a hidden value. Failures and
   * models that cannot see pictures give no labels.
   */
  async function labelsFor(actor: Actor, skill: Skill, input: DozoTeachInput) {
    const stored = await valuesFor(actor, skill);
    if (!deps.label || !stored?.images.length) return {};
    const events = parseRecording(skill.recording).events;
    const indexes = clickStepIndexes(input.playbook.steps, events);
    const kept = new Set(
      keptTeachClicks(skill.id, skill.recording, events, input).map((click) => click.eventIndex),
    );
    const pictures = stored.images.flatMap(({ eventIndex, image }) =>
      kept.has(eventIndex) && indexes.has(eventIndex)
        ? [{ id: teachTargetId(eventIndex), image }]
        : [],
    );
    if (!pictures.length) return {};
    return (await deps.label(actor, skill, pictures)) ?? {};
  }

  /**
   * The playbook with the decisions applied, for a test run. Someone else than the teacher sends
   * none: for them upstream's rules apply. Once saved, nothing typed is left to decide about.
   */
  async function decided(actor: Actor, input: DozoTeachInput) {
    const skill = await skillOf(actor, input.skillId);
    if (skill.userId !== actor.userId && Object.keys(input.decisions).length) {
      throw new ClientError(
        "FORBIDDEN",
        "Only the person who taught this skill can decide about its values",
      );
    }
    if (skill.status !== "draft" && Object.keys(input.decisions).length) {
      throw new ClientError("CONFLICT", "This skill is already saved", SKILL_NOT_DRAFT);
    }
    const values = (await valuesFor(actor, skill))?.values ?? [];
    const playbook = values.length
      ? applyValueDecisions(input.playbook, values, input.decisions)
      : input.playbook;
    if (skill.userId !== actor.userId || skill.status !== "draft") return { skill, playbook };
    // A test never asks the model about the pictures: its clicks say only their window.
    const events = parseRecording(skill.recording).events;
    const clicks = keptTeachClicks(skill.id, skill.recording, events, input);
    return {
      skill,
      playbook: clicks.length ? withClickTargets(playbook, events, clicks) : playbook,
    };
  }

  return {
    async review(
      actor: Actor,
      skillId: string,
    ): Promise<{ values: DozoTeachValue[]; targets: DozoTeachTarget[] }> {
      const skill = await skillOf(actor, skillId);
      const stored = await valuesFor(actor, skill);
      if (!stored) return { values: [], targets: [] };
      const targets = targetsFor(skill, stored);
      if (!stored.values.length) return { values: [], targets };
      const suggestions = stored.suggestions ?? (await suggestionsFor(actor, skill, stored.values));
      return {
        values: stored.values.map((value): DozoTeachValue => {
          const suggestion = suggestions[value.placeholder];
          return suggestion ? { ...value, suggestion: { name: suggestion.name } } : value;
        }),
        targets,
      };
    },

    /**
     * The labels for the kept pictures are asked first, outside the transaction; then one
     * transaction applies the decisions and the labels, saves, and forgets the values and every
     * picture (the wrapper's save).
     */
    async save(actor: Actor, input: DozoTeachInput) {
      const skill = await skillOf(actor, input.skillId);
      const labels = await labelsFor(actor, skill, input);
      return deps.taughtSkills.save(actor, input.skillId, input.name, {
        playbook: input.playbook,
        decisions: input.decisions,
        removedTargets: input.removedTargets,
        labels,
      });
    },

    /** The draft keeps its placeholders; only the test run's prompt has the decisions applied. */
    async test(actor: Actor, input: DozoTeachInput): Promise<{ runId: string }> {
      const { skill, playbook } = await decided(actor, input);
      await deps.taughtSkills.updateDraft(actor, input.skillId, {
        name: input.name,
        playbook: input.playbook,
      });
      const name = input.name || skill.name || skill.goal.slice(0, 80);
      return deps.taughtSkills.testRun(
        actor,
        input.skillId,
        formatSkillRunPrompt(name, playbook, true),
      );
    },
  };
}

/** The teach review procedures, served through the router's wrapper in `dozo-admin.ts`. */
export function dozoTeachRoutes(ctx: RouterContext) {
  const { deps, authed, taughtSkills } = ctx;
  const wiring = (deps as RouterDeps & { dozoTeach?: DozoTeachWiring }).dozoTeach;
  const teach = createDozoTeach({
    prisma: deps.prisma,
    taughtSkills,
    suggest: wiring?.suggest,
    label: wiring?.label,
  });
  return {
    dozoTeach: {
      review: authed.dozoTeach.review.handler(({ context, input }) =>
        teach.review(context.actor, input.skillId),
      ),
      save: authed.dozoTeach.save.handler(({ context, input }) => teach.save(context.actor, input)),
      test: authed.dozoTeach.test.handler(({ context, input }) => teach.test(context.actor, input)),
    },
  };
}
