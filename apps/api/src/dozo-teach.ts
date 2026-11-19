import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { TeachKeyOrder } from "@rakazo/adapters";
import {
  parsePlaybook,
  scheduleComputerSleep,
  sendTeachKeys,
  teachKeysContext,
} from "@rakazo/adapters";
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
  TEACH_SKILL_GONE,
  withClickTargets,
} from "@rakazo/core";
import type { PrismaClient, StoredTeachValues, TeachValueSuggestions } from "@rakazo/db";
import {
  cacheTeachSuggestions,
  forgetTeachImage,
  readTeachValues,
  storedTeachTargets,
} from "@rakazo/db";
import { expireStaleComputerControl, holdsComputerControl } from "./computer-control.js";
import type { createTaughtSkillsService } from "./dozo-taught-skills.js";
import {
  checkTeachLabels,
  forgetOldTeachTyping,
  keptTeachClicks,
  SKILL_NOT_DRAFT,
  teachRecordingOf,
  teachTargetId,
} from "./dozo-taught-skills.js";
import type { TeachClickLabeller } from "./dozo-teach-labels.js";
import { createTeachClickLabeller } from "./dozo-teach-labels.js";
import type { TeachValueSuggester } from "./dozo-teach-suggest.js";
import { createTeachValueSuggester, teachValueShape } from "./dozo-teach-suggest.js";
import type { RouterDeps } from "./router.js";
import type { RouterContext } from "./routes/context.js";

type TaughtSkills = Pick<
  ReturnType<typeof createTaughtSkillsService>,
  "updateDraft" | "save" | "testRun" | "decideSavedValues" | "recordKeys"
>;

export type DozoTeachInput = {
  skillId: string;
  name?: string;
  playbook: SkillPlaybook;
  decisions: Record<string, DozoTeachValueDecision>;
  removedTargets?: string[];
  /** The labels the teacher saw and kept, by click id. */
  labels?: Record<string, string>;
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
    // Deleted, or never in this Space: the card shows it gone and stops asking.
    if (!skill) throw new ClientError("NOT_FOUND", "This skill was deleted", TEACH_SKILL_GONE);
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
   * the recorded steps and each value's shape: never a value, nor a window title. Two first reviews at once may both
   * ask; the first to write is kept.
   */
  async function suggestionsFor(
    actor: Actor,
    skill: Skill,
    values: TeachTypedValue[],
  ): Promise<TeachValueSuggestions> {
    if (!deps.suggest) return {};
    const recording = teachRecordingOf(skill);
    const suggestions =
      (await deps.suggest(
        actor,
        {
          botId: skill.botId,
          goal: skill.goal,
          steps: buildPlaybookFromRecording(skill.goal, recording.events).steps,
        },
        values.map(teachValueShape),
      )) ?? {};
    return (await cacheTeachSuggestions(deps.prisma, skill.id, suggestions)) ?? suggestions;
  }

  /** The clicks the teacher reviews: those whose step is still in the draft, with their picture. */
  function targetsFor(skill: Skill, stored: StoredTeachValues): DozoTeachTarget[] {
    const events = teachRecordingOf(skill).events;
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
   * What the model sees each kept click hit, asked only when the teacher chooses to, and shown
   * to them before anything keeps it: never for a removed picture or one before a hidden value.
   * Failures and models that cannot see pictures give no labels.
   */
  async function labelsFor(
    actor: Actor,
    skill: Skill,
    decisions: Record<string, DozoTeachValueDecision>,
  ) {
    const stored = await valuesFor(actor, skill);
    if (!deps.label || !stored?.images.length) return {};
    const events = teachRecordingOf(skill).events;
    const kept = new Set(
      keptTeachClicks(skill.id, skill.recording, events, { decisions }).map(
        (click) => click.eventIndex,
      ),
    );
    const pictures = stored.images.flatMap(({ eventIndex, image }) =>
      kept.has(eventIndex) ? [{ id: teachTargetId(eventIndex), image }] : [],
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
    const stored = await valuesFor(actor, skill);
    const values = stored?.values ?? [];
    checkTeachLabels(input.labels, stored?.images ?? []);
    const playbook = values.length
      ? applyValueDecisions(input.playbook, values, input.decisions)
      : input.playbook;
    if (skill.userId !== actor.userId || skill.status !== "draft") return { skill, playbook };
    // A test never asks the model about the pictures: its clicks say their window and the
    // labels the teacher kept.
    const events = teachRecordingOf(skill).events;
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
      await forgetOldTeachTyping(deps.prisma, { spaceId: actor.spaceId, skillId });
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
     * One transaction applies the decisions and the labels the teacher kept, saves, and forgets
     * the values and every picture (the wrapper's save). The model is not asked here: a label
     * reaches a step only once the teacher has seen it.
     */
    async save(actor: Actor, input: DozoTeachInput) {
      return deps.taughtSkills.save(actor, input.skillId, input.name, {
        playbook: input.playbook,
        decisions: input.decisions,
        removedTargets: input.removedTargets,
        labels: input.labels,
      });
    },

    /** Labels for the kept pictures, for the teacher to see; nothing is kept. */
    async labelTargets(
      actor: Actor,
      input: { skillId: string; decisions: Record<string, DozoTeachValueDecision> },
    ): Promise<{ labels: Record<string, string> }> {
      const skill = await skillOf(actor, input.skillId);
      return { labels: await labelsFor(actor, skill, input.decisions) };
    },

    /** Forgets a click's picture at once; only its teacher may, and again is the same. */
    async removeTarget(actor: Actor, input: { skillId: string; targetId: string }) {
      const skill = await skillOf(actor, input.skillId);
      if (skill.userId !== actor.userId) {
        throw new ClientError(
          "FORBIDDEN",
          "Only the person who taught this skill can remove its pictures",
        );
      }
      if (/^\d+$/.test(input.targetId)) {
        await forgetTeachImage(deps.prisma, skill, Number(input.targetId));
      }
      return { ok: true as const };
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

/**
 * Keys typed in a row on a bot's computer, as `computer.input` takes one: only the person
 * holding the screen types on it; while they teach, the recording gets each key; otherwise the
 * keys just reach the computer, in order.
 */
export async function typeTeachKeys(
  ctx: {
    deps: RouterDeps;
    getBot: RouterContext["repos"]["getBot"];
    taughtSkills: Pick<TaughtSkills, "recordKeys">;
  },
  actor: Actor,
  botId: string,
  keys: string[],
  order?: TeachKeyOrder,
): Promise<{ ok: true }> {
  const bot = await ctx.getBot(actor, botId);
  const computer = bot.computer;
  if (!computer || !holdsComputerControl(computer, bot.id, actor)) {
    await expireStaleComputerControl(ctx.deps, computer);
    throw new ClientError("FORBIDDEN", "You are not controlling this computer");
  }
  if (!computer.providerRef) return { ok: true };
  const outcome = await ctx.taughtSkills.recordKeys(actor, bot.id, keys, order);
  if (outcome === "stale") return { ok: true };
  if (outcome === "idle") {
    await sendTeachKeys(ctx.deps.sandbox, computer, keys, teachKeysContext(actor, bot.id));
  }
  await ctx.deps.prisma.computer.updateMany({
    where: { id: computer.id, state: "running" },
    data: { updatedAt: new Date() },
  });
  scheduleComputerSleep(ctx.deps.jobs, computer.id);
  return { ok: true };
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
      labelTargets: authed.dozoTeach.labelTargets.handler(({ context, input }) =>
        teach.labelTargets(context.actor, input),
      ),
      removeTarget: authed.dozoTeach.removeTarget.handler(({ context, input }) =>
        teach.removeTarget(context.actor, input),
      ),
      test: authed.dozoTeach.test.handler(({ context, input }) => teach.test(context.actor, input)),
      decideSaved: authed.dozoTeach.decideSaved.handler(({ context, input }) =>
        taughtSkills.decideSavedValues(context.actor, input.skillId, input),
      ),
      keys: authed.dozoTeach.keys.handler(({ context, input }) =>
        typeTeachKeys(
          { deps, getBot: ctx.repos.getBot, taughtSkills },
          context.actor,
          input.botId,
          input.keys,
          input.order,
        ),
      ),
    },
  };
}
