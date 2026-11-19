import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { parseRecording } from "@rakazo/adapters";
import type {
  Actor,
  DozoTeachValue,
  DozoTeachValueDecision,
  SkillPlaybook,
} from "@rakazo/contracts";
import type { TeachTypedValue } from "@rakazo/core";
import {
  applyValueDecisions,
  buildPlaybookFromRecording,
  ClientError,
  formatSkillRunPrompt,
  teachWindowTitles,
} from "@rakazo/core";
import type { PrismaClient, StoredTeachValues, TeachValueSuggestions } from "@rakazo/db";
import { cacheTeachSuggestions, IsolationError, readTeachValues } from "@rakazo/db";
import type { createTaughtSkillsService } from "./dozo-taught-skills.js";
import { SKILL_NOT_DRAFT } from "./dozo-taught-skills.js";
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
};

/** What the teach routes need from the server that the router's own dependencies do not carry. */
export interface DozoTeachWiring {
  /** Absent when the server has no model runtime to ask; the review then has no suggestions. */
  suggest?: TeachValueSuggester;
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
  return { dozoTeach: { suggest: createTeachValueSuggester(deps) } };
}

type Skill = {
  id: string;
  userId: string;
  botId: string;
  name: string;
  goal: string;
  status: string;
  recording: unknown;
};

/**
 * Reviewing what was typed while teaching, and saving or testing a draft with the teacher's
 * decision for each typed value. The values come from the draft's short-lived store on the
 * server, never from the client, and only the person who taught the skill sees them or decides
 * about them.
 */
export function createDozoTeach(deps: {
  prisma: PrismaClient;
  taughtSkills: TaughtSkills;
  suggest?: TeachValueSuggester;
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
    if (!values.length) return { skill, playbook: input.playbook };
    return { skill, playbook: applyValueDecisions(input.playbook, values, input.decisions) };
  }

  return {
    async review(actor: Actor, skillId: string): Promise<{ values: DozoTeachValue[] }> {
      const skill = await skillOf(actor, skillId);
      const stored = await valuesFor(actor, skill);
      if (!stored?.values.length) return { values: [] };
      const suggestions = stored.suggestions ?? (await suggestionsFor(actor, skill, stored.values));
      return {
        values: stored.values.map((value): DozoTeachValue => {
          const suggestion = suggestions[value.placeholder];
          return suggestion ? { ...value, suggestion: { name: suggestion.name } } : value;
        }),
      };
    },

    /** One transaction applies the decisions, saves and forgets the values (the wrapper's save). */
    save(actor: Actor, input: DozoTeachInput) {
      return deps.taughtSkills.save(actor, input.skillId, input.name, {
        playbook: input.playbook,
        decisions: input.decisions,
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
  const teach = createDozoTeach({ prisma: deps.prisma, taughtSkills, suggest: wiring?.suggest });
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
