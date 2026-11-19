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

/** Pass `input` for an update; leave it out for a change that always touches run settings. */
export async function requireBotRunEditor(
  prisma: Db,
  actor: Actor,
  bot: RunSettings & { userId: string },
  input?: UpdateBotInput,
): Promise<void> {
  if (bot.userId === actor.userId) return;
  if (input && !changesRunSettings(bot, input)) return;
  await requireSpaceOwner(prisma, actor);
}

/** Any member can archive a group; only its creator or the space owner deletes it for good. */
export async function requireGroupRemover(
  prisma: Db,
  actor: Actor,
  groupId: string,
): Promise<void> {
  const group = await prisma.chatGroup.findFirst({
    where: { id: groupId, spaceId: actor.spaceId },
    select: { userId: true },
  });
  if (group && group.userId !== actor.userId) await requireSpaceOwner(prisma, actor);
}
