import type { Actor, UpdateBotInput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { requireSpaceOwner } from "@rakazo/db";

type Db = Pick<PrismaClient, "spaceMember" | "chatGroup">;

/**
 * A bot's triggered runs (check-ins, routines, webhooks, mail) act as its creator, so these
 * settings, which decide what those runs do and what they reach, are the creator's or the
 * space owner's to change. Name, look, model and placement stay open to every member.
 */
const RUN_SETTINGS = [
  "instructions",
  "dailyCheckIns",
  "fleetManagement",
  "crossSpaceCommunication",
  "teamChatAmbientEnabled",
  "teamChatRules",
  "memoryScope",
  "disabledBuiltinTools",
] as const;

type RunSettings = { [K in (typeof RUN_SETTINGS)[number]]?: unknown };

/** A save that resends a value unchanged changes nothing. */
function changesRunSettings(bot: RunSettings, input: RunSettings): boolean {
  return RUN_SETTINGS.some(
    (key) => input[key] !== undefined && JSON.stringify(input[key]) !== JSON.stringify(bot[key]),
  );
}

/**
 * Pass `input` for an update; leave it out for a change that always touches run settings. Answers
 * the bot, so a route reads and checks it in one expression.
 */
export async function requireBotRunEditor<Bot extends RunSettings & { userId: string }>(
  prisma: Db,
  actor: Actor,
  bot: Bot,
  input?: UpdateBotInput,
): Promise<Bot> {
  if (bot.userId !== actor.userId && (!input || changesRunSettings(bot, input))) {
    await requireSpaceOwner(prisma, actor);
  }
  return bot;
}

/**
 * Any member can archive a group; only its creator or the space owner deletes it for good.
 * Answers the group's id, so a route checks and removes in one expression.
 */
export async function requireGroupRemover(
  prisma: Db,
  actor: Actor,
  groupId: string,
): Promise<string> {
  const group = await prisma.chatGroup.findFirst({
    where: { id: groupId, spaceId: actor.spaceId },
    select: { userId: true },
  });
  if (group && group.userId !== actor.userId) await requireSpaceOwner(prisma, actor);
  return groupId;
}
