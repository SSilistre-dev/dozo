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
  ClientError,
  formatSkillRunPrompt,
  typedValuesFromRecording,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, readJsonColumn } from "@rakazo/db";
import * as z from "zod";
import type { createTaughtSkillsService } from "./dozo-taught-skills.js";
import type { TeachValueSuggester, TeachValueSuggestions } from "./dozo-teach-suggest.js";
import { createTeachValueSuggester } from "./dozo-teach-suggest.js";
import type { RouterDeps } from "./router.js";
import type { RouterContext } from "./routes/context.js";

/**
 * Where the recording keeps the model's suggestions, next to its events, until the save. An empty
 * record marks a call that gave none, so a failed call is not made again on every review.
 */
const SUGGESTIONS_KEY = "dozoSuggestions";
const StoredSuggestions = z.object({
  [SUGGESTIONS_KEY]: z
    .record(z.string(), z.object({ name: z.string(), secret: z.boolean().default(false) }))
    .optional(),
});

/** A save or test that decides about values of a skill no longer a draft. */
export const SKILL_NOT_DRAFT = "skill_not_draft";

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

/**
 * Reviewing what was typed while teaching, and saving or testing a draft with the teacher's
 * decision for each typed value. The values come from the recording on the server, never from
 * the client, and only the person who taught the skill sees them or decides about them.
 */
export function createDozoTeach(deps: {
  prisma: PrismaClient;
  taughtSkills: TaughtSkills;
  suggest?: TeachValueSuggester;
}) {
  async function skillOf(actor: Actor, skillId: string) {
    const skill = await deps.prisma.taughtSkill.findFirst({
      where: { id: skillId, spaceId: actor.spaceId },
    });
    if (!skill) throw new IsolationError();
    return skill;
  }

  function cachedSuggestions(id: string, recording: unknown): TeachValueSuggestions | undefined {
    return readJsonColumn(
      StoredSuggestions,
      recording,
      { table: "taught_skills", column: "recording", id },
      { fallback: {} },
    )[SUGGESTIONS_KEY];
  }

  /** The typed values the actor may decide about: the teacher's, while the skill is a draft. */
  function valuesFor(actor: Actor, skill: { userId: string; status: string; recording: unknown }) {
    if (skill.userId !== actor.userId || skill.status !== "draft") return [];
    return typedValuesFromRecording(parseRecording(skill.recording).events);
  }

  /**
   * The values with what the model said about them: a name, and a value it took for a secret is
   * one too, never kept as text and shown only as dots. The model saw no secret value, so
   * anything it says about one is made up and ignored.
   */
  function withSuggestions(values: TeachTypedValue[], suggestions: TeachValueSuggestions) {
    return values.map((value): DozoTeachValue => {
      const suggestion = value.secret ? undefined : suggestions[value.placeholder];
      if (!suggestion) return value;
      return { ...value, secret: suggestion.secret, suggestion: { name: suggestion.name } };
    });
  }

  /**
   * The playbook with the decisions applied. Someone else than the teacher sends none: for them
   * upstream's rules apply. Once saved, nothing typed is left to decide about.
   */
  async function decided(actor: Actor, input: DozoTeachInput) {
    const skill = await skillOf(actor, input.skillId);
    if (skill.userId !== actor.userId && Object.keys(input.decisions).length) {
      throw new ClientError(
        "FORBIDDEN",
        "Only the person who taught this skill can decide about its values",
      );
    }
    // The values are forgotten once saved: the decisions would apply to nothing, and the
    // client's placeholders would replace the saved steps.
    if (skill.status !== "draft" && Object.keys(input.decisions).length) {
      throw new ClientError("CONFLICT", "This skill is already saved", SKILL_NOT_DRAFT);
    }
    const values = withSuggestions(
      valuesFor(actor, skill),
      cachedSuggestions(skill.id, skill.recording) ?? {},
    );
    if (!values.length) return { skill, playbook: input.playbook };
    return { skill, playbook: applyValueDecisions(input.playbook, values, input.decisions) };
  }

  /**
   * Cached in the recording on the first review, failed or not, so the model is asked once per
   * skill. Two first reviews at once may both ask; the first to write is kept.
   */
  async function suggestionsFor(
    actor: Actor,
    skill: { id: string; botId: string; goal: string; recording: unknown },
    values: TeachTypedValue[],
  ): Promise<TeachValueSuggestions> {
    const cached = cachedSuggestions(skill.id, skill.recording);
    if (cached) return cached;
    if (!deps.suggest) return {};
    // Secret and protected values never reach the model.
    const open = values.flatMap((value) =>
      value.secret || value.text === null
        ? []
        : [{ placeholder: value.placeholder, text: value.text }],
    );
    const suggestions = (await deps.suggest(actor, skill, open)) ?? {};
    return deps.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ recording: unknown }>>`
        SELECT recording FROM taught_skills WHERE id = ${skill.id} AND status = 'draft'
        FOR UPDATE`;
      if (!row) return suggestions;
      const written = cachedSuggestions(skill.id, row.recording);
      if (written) return written;
      await tx.$executeRaw`
        UPDATE taught_skills
        SET recording = recording || jsonb_build_object(${SUGGESTIONS_KEY}::text, ${JSON.stringify(suggestions)}::jsonb)
        WHERE id = ${skill.id}`;
      return suggestions;
    });
  }

  return {
    async review(actor: Actor, skillId: string): Promise<{ values: DozoTeachValue[] }> {
      const skill = await skillOf(actor, skillId);
      const values = valuesFor(actor, skill);
      if (!values.length) return { values: [] };
      return { values: withSuggestions(values, await suggestionsFor(actor, skill, values)) };
    },

    /** Saves through the taught-skills service, whose save forgets what was typed. */
    async save(actor: Actor, input: DozoTeachInput) {
      const { playbook } = await decided(actor, input);
      await deps.taughtSkills.updateDraft(actor, input.skillId, { name: input.name, playbook });
      return deps.taughtSkills.save(actor, input.skillId, input.name);
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
