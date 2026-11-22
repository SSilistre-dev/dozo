import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { recordRoutineWriter } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

/**
 * Records who saved a routine in the app or the API: the bot's owner, whose save makes its prompt
 * their words for its runs' skill and routine writes, or another member (a guest included). A lost
 * record never counts for the owner wrongly, so it does not fail the save: the last one stays, and
 * a member's save also makes the routine theirs (its runs then act for them, not the bot's owner).
 */
export async function noteRoutineSaved(
  prisma: Pick<PrismaClient, "$queryRaw" | "$executeRaw">,
  actor: Actor,
  bot: { userId: string },
  routine: { id: string; spaceId: string },
): Promise<void> {
  const writer = actor.userId === bot.userId ? "owner" : "member";
  await bestEffort(
    "record a routine's writer",
    recordRoutineWriter(prisma, { routineId: routine.id, spaceId: routine.spaceId }, writer),
  );
}
