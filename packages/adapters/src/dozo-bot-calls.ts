import { isAppConnectionFollowUp, isDozoTokenNonce } from "@rakazo/core";
import { DOZO_BOT_CALLS_PER_DAY } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { requestUserCall } from "./calls/call-request.js";
import { ROUTINE_CALL_GUIDANCE } from "./dozo-bot-calls.prompt.js";
import { dozoInQuietHours, readDozoQuietHours } from "./dozo-quiet-hours.js";
import { dozoBotTokenTainted } from "./dozo-token-marks.js";
import { advisoryLock } from "./locks/advisory-lock.js";

const DAY_MS = 24 * 60 * 60_000;
/** Rows of the daily count are kept this long, which is longer than they are read. */
const LOG_KEEP_MS = 2 * DAY_MS;

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;
type Run = { id: string; userId: string; botId: string; threadId: string; trigger: string };

/**
 * Whose turn a run is, for ringing the person:
 * - `person`: a turn the person typed in the app (or their own chat-app message): may call.
 * - `routine`: a run a routine or watch of the person's own bot started, or a person's turn that
 *   a scheduled task joined: may call only with the person's permission, outside quiet hours and
 *   within the daily cap.
 * - `none`: anything else (another bot, a webhook, a token, a helper, a wake-up): never calls.
 */
export type CallStanding = "person" | "routine" | "none";

/** The triggers that can stand as the person's own turn; every other trigger never does. */
const isPersonTrigger = (trigger: string) =>
  trigger === "user" || trigger === "follow_up" || trigger === "reaction" || trigger === "messaging";

/**
 * The run's standing, from what is stored about it and never from text the model sees. A token's
 * message (the bot API, MCP) and a follow-up a bot queued are not the person's turn; a person's
 * turn that a webhook or a chat channel steered is not either, and one a schedule steered is a
 * routine's.
 */
export async function callStanding(
  prisma: Pick<PrismaClient, "run" | "steeringMessage" | "$queryRaw" | "$executeRaw">,
  run: Run,
): Promise<CallStanding> {
  const stored = await prisma.run.findUnique({
    where: { id: run.id },
    select: {
      routineId: true,
      clientNonce: true,
      sourceMessage: { select: { role: true, clientNonce: true } },
    },
  });
  if (run.trigger === "routine") {
    // A schedule's own run of the person's bot; a token that marked the bot may have written it.
    if (!stored?.routineId || (await dozoBotTokenTainted(prisma, run))) return "none";
    return "routine";
  }
  if (!isPersonTrigger(run.trigger)) return "none";
  const source = stored?.sourceMessage;
  if (isDozoTokenNonce(source?.clientNonce)) return "none";
  if (run.trigger === "follow_up") {
    if (source?.role !== "user" || isAppConnectionFollowUp({ ...run, clientNonce: stored?.clientNonce ?? null }))
      return "none";
  }
  const joined = await prisma.steeringMessage.findMany({
    where: { runId: run.id, originTrigger: { in: ["routine", "webhook", "messaging"] } },
    select: { originTrigger: true },
  });
  if (
    joined.some(
      ({ originTrigger }) =>
        originTrigger === "webhook" || (originTrigger === "messaging" && run.trigger !== "messaging"),
    )
  )
    return "none";
  return joined.some(({ originTrigger }) => originTrigger === "routine") ? "routine" : "person";
}

/** Calls can be made at all for this person: the server has them on and a voice is connected. */
export async function botCallsAvailable(
  deps: { prisma: Pick<PrismaClient, "userVoiceCredential">; env?: { phoneCallsEnabled?: boolean } },
  userId: string,
): Promise<boolean> {
  if (!deps.env?.phoneCallsEnabled) return false;
  const voice = await deps.prisma.userVoiceCredential.findFirst({
    where: { userId },
    select: { id: true },
  });
  return Boolean(voice);
}

export async function readBotCallPermission(
  db: Pick<PrismaClient, "$queryRaw">,
  userId: string,
  botId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ botId: string }>>`
    SELECT "botId" FROM dozo_bot_calls WHERE "userId" = ${userId} AND "botId" = ${botId}`;
  return rows.length > 0;
}

/** Sets the permission for the bot's own person; a bot that is not theirs in `spaceId` writes nothing. */
export async function writeBotCallPermission(
  db: Db,
  input: { userId: string; botId: string; spaceId: string; allowed: boolean },
): Promise<void> {
  if (!input.allowed) {
    await db.$executeRaw`
      DELETE FROM dozo_bot_calls WHERE "userId" = ${input.userId} AND "botId" = ${input.botId}`;
    return;
  }
  await db.$executeRaw`
    INSERT INTO dozo_bot_calls ("userId", "botId", "spaceId")
    SELECT b."userId", b."id", b."spaceId" FROM "bots" b
    WHERE b."id" = ${input.botId} AND b."spaceId" = ${input.spaceId} AND b."userId" = ${input.userId}
    ON CONFLICT ("userId", "botId") DO NOTHING`;
}

/** Whether `call_user` is offered in this run, decided by {@link callStanding} and the permission. */
export async function dozoMayOfferCall(
  deps: { prisma: PrismaClient },
  run: Run,
): Promise<boolean> {
  const standing = await callStanding(deps.prisma, run);
  if (standing === "none") return false;
  if (standing === "person") return true;
  return runAsSystem("read the owner's permission for the bot to call", () =>
    readBotCallPermission(deps.prisma, run.userId, run.botId),
  );
}

/** `call_user` as a routine's run sees it, with the guidance for when to call; others unchanged. */
export function dozoCallToolFor(trigger: string) {
  return <T extends { name: string; description: string }>(tool: T): T =>
    tool.name === "call_user" && trigger === "routine"
      ? { ...tool, description: `${tool.description} ${ROUTINE_CALL_GUIDANCE}` }
      : tool;
}

/**
 * Takes one of the bot's calls for the day, or says why not: quiet hours first, then the cap. The
 * count and the row that takes the slot are one step under the call lock, so two routines ringing
 * at once cannot both take the last slot. Returns the row to give back if the call is refused.
 */
export async function takeRoutineCall(
  prisma: PrismaClient,
  run: Run,
  now: Date,
): Promise<{ error: string } | { slot: string }> {
  return runAsSystem("take a routine's call for the day", async () => {
    const [ranges, user] = await Promise.all([
      readDozoQuietHours(prisma, run.userId),
      prisma.user.findUnique({ where: { id: run.userId }, select: { timezone: true } }),
    ]);
    if (dozoInQuietHours(ranges, now, user?.timezone ?? "UTC"))
      return {
        error: "It is within the user's quiet hours, so you may not call. Leave a message instead.",
      };
    return prisma.$transaction(async (tx) => {
      await advisoryLock(tx, "call", run.userId, "joined");
      const [row] = await tx.$queryRaw<Array<{ calls: number }>>`
        SELECT count(*)::int AS calls FROM dozo_bot_call_log
        WHERE "botId" = ${run.botId} AND "createdAt" > ${new Date(now.getTime() - DAY_MS)}`;
      if (row!.calls >= DOZO_BOT_CALLS_PER_DAY)
        return {
          error: `You already called the user ${DOZO_BOT_CALLS_PER_DAY} times in the last day, the most a bot may. Leave a message instead.`,
        };
      await tx.$executeRaw`
        DELETE FROM dozo_bot_call_log WHERE "createdAt" < ${new Date(now.getTime() - LOG_KEEP_MS)}`;
      const [slot] = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO dozo_bot_call_log ("userId", "botId", "createdAt")
        VALUES (${run.userId}, ${run.botId}, ${now}) RETURNING id`;
      return { slot: slot!.id };
    });
  });
}

/**
 * `requestUserCall` for a run's `call_user`. A run that is not the person's own turn may not call
 * at all, except one a routine or watch of their own bot started, and only with their permission,
 * outside quiet hours and within the daily cap; outside content the routine read does not stop it.
 * A refusal is the tool's answer, so the bot leaves a message instead. The cooldown stays with
 * `requestUserCall`. The deps and run are the executor's.
 */
export async function dozoRequestUserCall(
  deps: Parameters<typeof requestUserCall>[0] & { prisma: PrismaClient },
  run: Parameters<typeof requestUserCall>[1] & Run,
  input: { reason: string; opening: string },
  now = new Date(),
) {
  const standing = await callStanding(deps.prisma, run);
  if (standing === "none") return { error: "Calls are not available in this run." };
  if (standing === "person") return requestUserCall(deps, run, input);
  const allowed = await runAsSystem("read the owner's permission for the bot to call", () =>
    readBotCallPermission(deps.prisma, run.userId, run.botId),
  );
  if (!allowed)
    return { error: "The user has not allowed this bot to call from routines. Leave a message." };
  const taken = await takeRoutineCall(deps.prisma, run, now);
  if ("error" in taken) return taken;
  const result = await requestUserCall(deps, run, input);
  if ("error" in result)
    await runAsSystem("give back a call that was refused", () =>
      deps.prisma.$executeRaw`DELETE FROM dozo_bot_call_log WHERE id = ${taken.slot}`,
    );
  return result;
}
