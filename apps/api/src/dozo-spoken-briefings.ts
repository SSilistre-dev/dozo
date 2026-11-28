import { ownSpeechReady, spokenBriefingCoHost } from "@rakazo/adapters";
import type { Actor, DozoSpokenBriefing } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RouterDeps } from "./router.js";
import type { RouterContext } from "./routes/context.js";

type Deps = Pick<RouterDeps, "prisma" | "events">;

/**
 * The caller's own routine of a bot that is not archived. A briefing speaks with the owner's
 * voice connection and their bots' voices, so nobody else reads or sets it.
 */
async function ownRoutine(prisma: PrismaClient, actor: Actor, routineId: string) {
  const routine = await prisma.routine.findFirst({
    where: {
      id: routineId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
    },
    select: { id: true, bot: { select: { id: true, voiceId: true } } },
  });
  if (!routine) throw new IsolationError();
  return routine;
}

/** The owner's other bots in the Space that speak in a voice of their own, by name. */
function coHosts(prisma: PrismaClient, actor: Actor, hostId: string) {
  return prisma.bot.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
      id: { not: hostId },
      AND: [{ voiceId: { not: null } }, { voiceId: { not: "" } }],
    },
    orderBy: { name: "asc" },
    take: 500,
    select: { id: true, name: true },
  });
}

export async function readSpokenBriefing(
  prisma: PrismaClient,
  actor: Actor,
  routineId: string,
): Promise<DozoSpokenBriefing> {
  const routine = await ownRoutine(prisma, actor, routineId);
  const [coHostBotId, choices, speaks] = await Promise.all([
    spokenBriefingCoHost(prisma, routine.id),
    coHosts(prisma, actor, routine.bot.id),
    ownSpeechReady(prisma, actor),
  ]);
  return {
    available: speaks && Boolean(routine.bot.voiceId) && choices.length > 0,
    coHostBotId,
    coHosts: choices,
  };
}

export async function setSpokenBriefing(
  deps: Deps,
  actor: Actor,
  input: { routineId: string; coHostBotId: string | null },
): Promise<DozoSpokenBriefing> {
  const { prisma } = deps;
  const routine = await ownRoutine(prisma, actor, input.routineId);
  if (input.coHostBotId === null) {
    await prisma.$executeRaw`
      DELETE FROM dozo_spoken_briefings WHERE "routineId" = ${routine.id}`;
  } else {
    const choices = await coHosts(prisma, actor, routine.bot.id);
    if (!choices.some((bot) => bot.id === input.coHostBotId)) throw new IsolationError();
    await prisma.$executeRaw`
      INSERT INTO dozo_spoken_briefings ("routineId", "spaceId", "coHostBotId")
      VALUES (${routine.id}, ${actor.spaceId}, ${input.coHostBotId})
      ON CONFLICT ("routineId") DO UPDATE SET "coHostBotId" = EXCLUDED."coHostBotId"`;
  }
  await bestEffort(
    "spoken briefing routine change",
    deps.events?.publishSpaceChange?.(actor.spaceId, "routines"),
  );
  return readSpokenBriefing(prisma, actor, routine.id);
}

export function dozoSpokenBriefingRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoSpokenBriefings: {
      get: authed.dozoSpokenBriefings.get.handler(({ context, input }) =>
        readSpokenBriefing(deps.prisma, context.actor, input.routineId),
      ),
      set: authed.dozoSpokenBriefings.set.handler(({ context, input }) =>
        setSpokenBriefing(deps, context.actor, input),
      ),
    },
  };
}
