import type { Actor } from "@rakazo/contracts";
import { buildPlaybookFromRecording } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { LearningSkillSuggestion } from "./dozo-learning-apply.js";
import { learningNoteKey } from "./dozo-learning-apply.js";
import {
  lockSkillSuggestion,
  rejectedLearningSkills,
  setSkillSuggestion,
} from "./dozo-learning-store.js";
import { listAgentSkillRecords } from "./skill-tools.js";
import type { TaughtSkillRow } from "./teaching-session.js";
import { emitSkillDraftMessages, emptyRecording } from "./teaching-session.js";

// A skill a learning review suggests: a draft taught skill and the draft card teaching posts,
// in the bot's own chat, for the owner to save or dismiss. Never saved without them, in any mode.

export type LearningSkillDeps = {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "notify">;
};
type Bot = { id: string; spaceId: string; userId: string };

/** The most skill names a review is shown. */
const NAMES_SHOWN = 50;

/**
 * The names of every skill the bot already has: its own taught skills (drafts included) and the
 * catalog its runs read. Only names: a description someone else wrote stays out of the review.
 */
async function skillNames(prisma: Pick<PrismaClient, "taughtSkill" | "agentSkill">, bot: Bot) {
  const [taught, catalog] = await Promise.all([
    prisma.taughtSkill.findMany({
      where: { botId: bot.id, spaceId: bot.spaceId, status: { in: ["draft", "saved"] } },
      orderBy: { updatedAt: "desc" },
      select: { name: true, goal: true },
    }),
    listAgentSkillRecords(prisma as PrismaClient, { spaceId: bot.spaceId, userId: bot.userId }),
  ]);
  const names = [
    ...taught.map((skill) => skill.name || skill.goal.slice(0, 80)),
    ...catalog.map((skill) => skill.name),
  ];
  return [...new Set(names)];
}

/** The newest of those names, the ones a review is shown. */
export async function knownSkillNames(prisma: PrismaClient, bot: Bot): Promise<string[]> {
  return (await skillNames(prisma, bot)).slice(0, NAMES_SHOWN);
}

/**
 * Posts the draft's card. Never fails the review: the draft is made, and while it is unanswered
 * the next suggestion posts its missing card.
 */
const draftCardFor = (deps: LearningSkillDeps, bot: Bot, skill: TaughtSkillRow) =>
  bestEffort("learning skill card", postCard(deps, bot, skill));

const postCard = (deps: LearningSkillDeps, bot: Bot, skill: TaughtSkillRow) =>
  deps.prisma.bot.findUnique({ where: { id: bot.id }, include: { thread: true } }).then((found) =>
    // Teaching's own card: the draft's Save and Dismiss, and its updates, live in this chat.
    found
      ? emitSkillDraftMessages(
          deps,
          { spaceId: bot.spaceId, userId: bot.userId } as Actor,
          skill,
          found,
        )
      : undefined,
  );

/**
 * Suggests the skill as a draft card unless one named the same (in any spacing or case) exists
 * or was dismissed, read under the bot's lock, so a skill saved or dismissed while the model
 * answered counts; or the bot's last suggestion is still unanswered: then only that one's card is
 * posted again when it is missing (a crash between the draft and its card). Answers whether a
 * new draft was made.
 */
export async function suggestLearnedSkill(
  deps: LearningSkillDeps,
  bot: Bot,
  skill: LearningSkillSuggestion,
): Promise<boolean> {
  const made = await deps.prisma.$transaction(async (tx) => {
    const row = await lockSkillSuggestion(tx, bot.id);
    if (!row) return null;
    if (row.pendingSkillId) return { pending: row.pendingSkillId };
    const taken = [...(await skillNames(tx, bot)), ...(await rejectedLearningSkills(tx, bot.id))];
    if (taken.some((name) => learningNoteKey(name) === learningNoteKey(skill.name))) return null;
    const playbook = {
      ...buildPlaybookFromRecording(skill.whenToUse, []),
      inputs: skill.inputs,
      steps: skill.steps,
      whatToReturn: skill.whatToReturn,
    };
    const draft = await tx.taughtSkill.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        userId: bot.userId,
        name: skill.name,
        goal: skill.whenToUse,
        status: "draft",
        playbook: playbook as never,
        recording: emptyRecording() as never,
      },
    });
    await setSkillSuggestion(tx, bot.id, draft.id);
    return { draft };
  });
  if (!made) return false;
  if ("pending" in made) {
    const pending = await deps.prisma.taughtSkill.findUnique({ where: { id: made.pending } });
    if (pending) await draftCardFor(deps, bot, pending);
    return false;
  }
  await draftCardFor(deps, bot, made.draft);
  return true;
}
