import { CALL_CLIENT_NONCE_PREFIX } from "@rakazo/core";
import { DOZO_BOT_CALLS_PER_DAY } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { requestUserCall } from "./calls/call-request.js";
import { readDozoQuietHours, dozoInQuietHours } from "./dozo-quiet-hours.js";
import { ROUTINE_CALL_GUIDANCE } from "./dozo-bot-calls.prompt.js";
import { isRunTainted } from "./runs/assembly/run-context.js";
import type { RunContext } from "./runs/assembly/run-context.js";

const DAY_MS = 24 * 60 * 60_000;

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

/**
 * Who may start a call. A person's own turn always could. A routine (a schedule or a watch) may
 * only with the person's permission for that bot. A webhook or another bot starts a run from text
 * the owner did not write, so it never calls.
 */
export function callGate(trigger: string): "person" | "routine" | "never" {
  if (trigger === "routine") return "routine";
  return trigger === "webhook" || trigger === "bot_message" ? "never" : "person";
}

/** Calls can be made at all for this person: the server has them on and a voice is connected. */
export async function botCallsAvailable(
  deps: { prisma: Pick<PrismaClient, "userVoiceCredential">; phoneCallsEnabled?: boolean },
  userId: string,
): Promise<boolean> {
  if (!deps.phoneCallsEnabled) return false;
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

/** Whether `call_user` is offered in this run: gates by who started it (see {@link callGate}). */
export async function dozoMayOfferCall(
  deps: { prisma: PrismaClient },
  run: { trigger: string; userId: string },
  bot: { id: string },
): Promise<boolean> {
  const gate = callGate(run.trigger);
  if (gate === "never") return false;
  if (gate === "person") return true;
  return runAsSystem("read the owner's permission for the bot to call", () =>
    readBotCallPermission(deps.prisma, run.userId, bot.id),
  );
}

/** `call_user` as a routine's run sees it, with the guidance for when to call; others unchanged. */
export function dozoCallToolFor(trigger: string) {
  return <T extends { name: string; description: string }>(tool: T): T =>
    tool.name === "call_user" && callGate(trigger) === "routine"
      ? { ...tool, description: `${tool.description} ${ROUTINE_CALL_GUIDANCE}` }
      : tool;
}

/** Why a routine's call may not ring now, or null. Quiet hours, then the daily cap. */
async function routineCallRefusal(
  prisma: PrismaClient,
  run: { userId: string; botId: string },
  now: Date,
): Promise<string | null> {
  const [ranges, user, today] = await runAsSystem("check a routine's call limits", () =>
    Promise.all([
      readDozoQuietHours(prisma, run.userId),
      prisma.user.findUnique({ where: { id: run.userId }, select: { timezone: true } }),
      prisma.message.count({
        where: {
          role: "bot",
          clientNonce: { startsWith: CALL_CLIENT_NONCE_PREFIX, endsWith: ":request" },
          createdAt: { gt: new Date(now.getTime() - DAY_MS) },
          thread: { userId: run.userId, botId: run.botId },
        },
      }),
    ]),
  );
  if (dozoInQuietHours(ranges, now, user?.timezone ?? "UTC"))
    return "It is within the user's quiet hours, so you may not call. Leave a message instead.";
  if (today >= DOZO_BOT_CALLS_PER_DAY)
    return `You already called the user ${DOZO_BOT_CALLS_PER_DAY} times in the last day, the most a bot may. Leave a message instead.`;
  return null;
}

/**
 * `requestUserCall` for a run's `call_user`. A run the person did not start may not call at all
 * unless it is their own routine with their permission, no outside content has reached it, and
 * the quiet hours and the daily cap leave room. The refusal is the tool's answer, so the bot
 * leaves a message instead. The cooldown and the rest stay with `requestUserCall`.
 */
export async function dozoRequestUserCall(
  ctx: RunContext,
  input: { reason: string; opening: string },
  now = new Date(),
) {
  const { deps, run } = ctx;
  const gate = callGate(run.trigger);
  if (gate === "never") return { error: "Calls are not available in this run." };
  if (gate === "routine") {
    if (!(await dozoMayOfferCall(deps, run, ctx.bot)))
      return { error: "The user has not allowed this bot to call from routines. Leave a message." };
    // Text from a page, an email or another bot must not decide to ring the person.
    if (await isRunTainted(ctx))
      return {
        error:
          "This run has read outside content, so it may not call. Leave a message instead.",
      };
    const refusal = await routineCallRefusal(deps.prisma, run, now);
    if (refusal) return { error: refusal };
  }
  return requestUserCall(deps, run, input);
}
