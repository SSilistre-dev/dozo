import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { parseRecording } from "@rakazo/adapters";
import type {
  Actor,
  DozoTeachTarget,
  DozoTeachValue,
  DozoTeachValueDecision,
  SkillPlaybook,
} from "@rakazo/contracts";
import type { TeachRecordingEvent, TeachTypedValue } from "@rakazo/core";
import {
  applyValueDecisions,
  ClientError,
  clickStepIndexes,
  clicksBeforeSecrets,
  formatSkillRunPrompt,
  secretInputName,
  typedValuesFromRecording,
  withClickTargets,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, readJsonColumn, storedTeachTargets } from "@rakazo/db";
import * as z from "zod";
import type { createTaughtSkillsService } from "./dozo-taught-skills.js";
import type { TeachClickLabeller, TeachClickLabels } from "./dozo-teach-labels.js";
import { createTeachClickLabeller } from "./dozo-teach-labels.js";
import type { TeachValueSuggester, TeachValueSuggestions } from "./dozo-teach-suggest.js";
import { createTeachValueSuggester } from "./dozo-teach-suggest.js";
import type { RouterDeps } from "./router.js";
import type { RouterContext } from "./routes/context.js";

/**
 * Where the recording keeps what the model said, next to its events, until the save: names for
 * the typed values, and labels for the clicked things. An empty record marks a call that gave
 * none, so a failed call is not made again on every review.
 */
const SUGGESTIONS_KEY = "dozoSuggestions";
const LABELS_KEY = "dozoLabels";
const StoredModelAnswers = z.object({
  [SUGGESTIONS_KEY]: z
    .record(z.string(), z.object({ name: z.string(), secret: z.boolean().default(false) }))
    .optional(),
  [LABELS_KEY]: z.record(z.string(), z.string()).optional(),
});
type StoredModelAnswers = z.infer<typeof StoredModelAnswers>;

/** A save or test that decides about values of a skill no longer a draft. */
export const SKILL_NOT_DRAFT = "skill_not_draft";

type TaughtSkills = Pick<
  ReturnType<typeof createTaughtSkillsService>,
  "updateDraft" | "save" | "testRun"
>;

type SkillRow = {
  id: string;
  botId: string;
  userId: string;
  status: string;
  goal: string;
  playbook: unknown;
  recording: unknown;
};

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
  /** Absent likewise; the clicks then have no labels. */
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

/** A target's id: the index of its click's event, which never changes once recorded. */
const targetId = (eventIndex: number) => String(eventIndex);

/**
 * Reviewing what was typed and clicked while teaching, and saving or testing a draft with the
 * teacher's decision for each typed value and each click's picture. Values and clicks come from
 * the recording on the server, never from the client, and only the person who taught the skill
 * sees them or decides about them.
 */
export function createDozoTeach(deps: {
  prisma: PrismaClient;
  taughtSkills: TaughtSkills;
  suggest?: TeachValueSuggester;
  label?: TeachClickLabeller;
}) {
  async function skillOf(actor: Actor, skillId: string) {
    const skill = await deps.prisma.taughtSkill.findFirst({
      where: { id: skillId, spaceId: actor.spaceId },
    });
    if (!skill) throw new IsolationError();
    return skill;
  }

  function cached(id: string, recording: unknown): StoredModelAnswers {
    return readJsonColumn(
      StoredModelAnswers,
      recording,
      { table: "taught_skills", column: "recording", id },
      { fallback: {} },
    );
  }

  const isReviewer = (actor: Actor, skill: SkillRow) =>
    skill.userId === actor.userId && skill.status === "draft";

  /** The typed values the actor may decide about: the teacher's, while the skill is a draft. */
  function valuesFor(actor: Actor, skill: SkillRow) {
    if (!isReviewer(actor, skill)) return [];
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
   * The recorded clicks the teacher reviews: those whose step is still in `steps`, with their
   * window, and their picture unless a secret value was typed next. The drafting already dropped
   * the pictures before a secret by the recording's own rule; `values` adds what the model took
   * for one.
   */
  function clicksFor(
    actor: Actor,
    skill: SkillRow,
    events: TeachRecordingEvent[],
    steps: string[],
    values: DozoTeachValue[],
  ) {
    if (!isReviewer(actor, skill)) return [];
    const indexes = clickStepIndexes(steps, events);
    const secret = clicksBeforeSecrets(
      events,
      values.filter((value) => value.secret).map((value) => value.placeholder),
    );
    return storedTeachTargets(skill.id, skill.recording).flatMap(({ image, ...target }) => {
      const step = indexes.get(target.eventIndex);
      if (step === undefined) return [];
      return [
        {
          ...target,
          id: targetId(target.eventIndex),
          step,
          ...(image && !secret.has(target.eventIndex) ? { image } : {}),
        },
      ];
    });
  }

  /**
   * The model's answer cached in the recording on the first review, failed or not, so it is asked
   * once per skill. Two first reviews at once may both ask; the first to write is kept.
   */
  async function cachedAnswer<K extends keyof StoredModelAnswers>(
    skill: SkillRow,
    key: K,
    ask: () => Promise<NonNullable<StoredModelAnswers[K]> | null>,
  ): Promise<NonNullable<StoredModelAnswers[K]>> {
    const empty = {} as NonNullable<StoredModelAnswers[K]>;
    const stored = cached(skill.id, skill.recording)[key];
    if (stored) return stored;
    const answer = (await ask()) ?? empty;
    return deps.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ recording: unknown }>>`
        SELECT recording FROM taught_skills WHERE id = ${skill.id} AND status = 'draft'
        FOR UPDATE`;
      if (!row) return answer;
      const written = cached(skill.id, row.recording)[key];
      if (written) return written;
      await tx.$executeRaw`
        UPDATE taught_skills
        SET recording = recording || jsonb_build_object(${key}::text, ${JSON.stringify(answer)}::jsonb)
        WHERE id = ${skill.id}`;
      return answer;
    });
  }

  function suggestionsFor(actor: Actor, skill: SkillRow, values: TeachTypedValue[]) {
    const suggest = deps.suggest;
    // With no model to ask there is nothing new to cache.
    if (!suggest) {
      return Promise.resolve(cached(skill.id, skill.recording)[SUGGESTIONS_KEY] ?? {});
    }
    return cachedAnswer(skill, SUGGESTIONS_KEY, async () => {
      // Secret and protected values never reach the model.
      const open = values.flatMap((value) =>
        value.secret || value.text === null
          ? []
          : [{ placeholder: value.placeholder, text: value.text }],
      );
      return suggest(actor, skill, open);
    });
  }

  /** Only pictures the teacher may see are sent: none of a click before a secret value. */
  function labelsFor(actor: Actor, skill: SkillRow, clicks: Array<{ id: string; image?: string }>) {
    const pictures = clicks.flatMap((click) =>
      click.image ? [{ id: click.id, image: click.image }] : [],
    );
    const label = deps.label;
    if (!label || !pictures.length) {
      return Promise.resolve<TeachClickLabels>(cached(skill.id, skill.recording)[LABELS_KEY] ?? {});
    }
    return cachedAnswer(skill, LABELS_KEY, () => label(actor, skill, pictures));
  }

  /**
   * The playbook with the decisions applied. Someone else than the teacher sends none: for them
   * upstream's rules apply. Once saved, nothing typed is left to decide about. Each click the
   * teacher kept says what it hit, from labels already made: the save never asks the model. A
   * click before a secret value says nothing of what it hit, also when only the teacher's name
   * for the value makes it one: its label was read off a picture of that field.
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
    const answers = cached(skill.id, skill.recording);
    const values = withSuggestions(valuesFor(actor, skill), answers[SUGGESTIONS_KEY] ?? {});
    const playbook = values.length
      ? applyValueDecisions(input.playbook, values, input.decisions)
      : input.playbook;
    const events = parseRecording(skill.recording).events;
    const removed = new Set(input.removedTargets ?? []);
    const labels = answers[LABELS_KEY] ?? {};
    const secret = clicksBeforeSecrets(
      events,
      values.flatMap((value) => {
        const decision = input.decisions[value.placeholder];
        const named = decision?.action === "variable" && secretInputName(decision.name);
        return value.secret || named ? [value.placeholder] : [];
      }),
    );
    const kept = clicksFor(actor, skill, events, input.playbook.steps, values).flatMap((click) =>
      removed.has(click.id) || secret.has(click.eventIndex)
        ? []
        : [{ eventIndex: click.eventIndex, window: click.window, label: labels[click.id] }],
    );
    return { skill, playbook: kept.length ? withClickTargets(playbook, events, kept) : playbook };
  }

  return {
    async review(
      actor: Actor,
      skillId: string,
    ): Promise<{ values: DozoTeachValue[]; targets: DozoTeachTarget[] }> {
      const skill = await skillOf(actor, skillId);
      if (!isReviewer(actor, skill)) return { values: [], targets: [] };
      const typed = valuesFor(actor, skill);
      const values = typed.length
        ? withSuggestions(typed, await suggestionsFor(actor, skill, typed))
        : [];
      const events = parseRecording(skill.recording).events;
      const steps = (skill.playbook as { steps?: unknown } | null)?.steps;
      const clicks = clicksFor(
        actor,
        skill,
        events,
        Array.isArray(steps) ? steps.map(String) : [],
        values,
      );
      const labels = await labelsFor(actor, skill, clicks);
      const targets = clicks.map(({ id, step, window, image }) => ({
        id,
        step,
        ...(window ? { window } : {}),
        ...(image ? { image: `data:image/webp;base64,${image}` } : {}),
        ...(labels[id] ? { label: labels[id] } : {}),
      }));
      return { values, targets };
    },

    /** Saves through the taught-skills service, whose save forgets what was typed and clicked. */
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
