import type { MessageBlock } from "@rakazo/contracts";
import { outsideRunToolRequiresApproval } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { RunContext } from "./run-context.js";

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;
type TokenRun = { deps: { prisma: Db }; run: { id: string; botId: string; spaceId: string } };

/** Runs known to have been reached by a token's text. Only a yes is kept: one can still arrive. */
const tokenRuns = new WeakSet<object>();

/**
 * Builtin tools whose call makes another bot act: the bot it names is marked too, so the work a
 * token's text hands on is asked about there as well. A child bot (`spawn_bot`) is reached through
 * its parent, and a routine or background helper of the same bot through the bot itself.
 */
const DELEGATING_TOOLS = new Set(["message_bot", "handoff_to_bot", "create_child_routine"]);

/** The card says why it asks. */
export const DOZO_TOKEN_CARD_REASON = "Asked by a message sent with an access token";

/**
 * Whether a run's bot holds text that came in with a personal access token (dozo-token-source.ts):
 * a message sent with one in the bot's chat or the run's own chat, still there (clearing the chat
 * removes it); a mark left by a run of another bot that had such text and reached this one, until
 * this bot's chat is cleared after it; or the same for a bot it was spawned from. Text from a token
 * may come from another program or agent, so it is never treated as the owner's own request, and
 * the history it stays in keeps every later run of the bot asking.
 *
 * `'api:%'` is DOZO_TOKEN_NONCE_PREFIX written out, so the partial index on messages is used.
 * Upstream's `createdAt` columns are UTC without a zone, so they are read as UTC before comparing.
 */
export async function dozoBotTokenTainted(
  db: Db,
  run: { botId: string; threadId: string },
): Promise<boolean> {
  const rows = await db.$queryRaw<{ sourced: boolean }[]>`
    WITH RECURSIVE lineage (id, depth) AS (
      SELECT ${run.botId}::text, 0
      UNION ALL
      SELECT b."parentBotId", l.depth + 1 FROM bots b JOIN lineage l ON b.id = l.id
      WHERE b."parentBotId" IS NOT NULL AND l.depth < 8
    )
    SELECT (
      EXISTS (SELECT 1 FROM messages m
        WHERE m."threadId" = ${run.threadId} AND m."clientNonce" LIKE 'api:%')
      OR EXISTS (SELECT 1 FROM lineage l JOIN threads t ON t."botId" = l.id
        JOIN messages m ON m."threadId" = t.id WHERE m."clientNonce" LIKE 'api:%')
      OR EXISTS (SELECT 1 FROM lineage l JOIN dozo_token_taints x ON x."botId" = l.id
        WHERE NOT EXISTS (SELECT 1 FROM threads t JOIN events e ON e."threadId" = t.id
          WHERE t."botId" = x."botId" AND e.type = 'thread.cleared'
            AND e."createdAt" AT TIME ZONE 'UTC' > x."createdAt"))
    ) AS sourced`;
  return rows[0]?.sourced === true;
}

/** dozoBotTokenTainted for a running run, remembered once true. */
export async function runCameByToken(ctx: Pick<RunContext, "deps" | "run">): Promise<boolean> {
  if (tokenRuns.has(ctx)) return true;
  const sourced = await dozoBotTokenTainted(ctx.deps.prisma, ctx.run);
  if (sourced) tokenRuns.add(ctx);
  return sourced;
}

/**
 * The gate's plan, except in a run reached by a token's text: every call that is not a plain read
 * asks the person, whatever the approval mode, rules or review would do. That is upstream's set
 * for webhook runs (builtins outside OUTSIDE_RUN_SAFE_BUILTIN_TOOLS: the computer, the browser,
 * files, memory, settings, other bots, routines), plus every call upstream already counts as
 * consequential (sends, connector writes, the user's own computer). A refusal stays a refusal.
 * A delegating call marks the bot it names before it is asked about.
 */
export async function dozoTokenRunPlan<Plan extends string>(
  ctx: TokenRun,
  call: {
    name: string;
    args: Record<string, unknown>;
    viaConnector: boolean;
    consequential: boolean;
  },
  plan: Plan,
): Promise<Plan | "ask"> {
  if (plan === "deny") return plan;
  const outward =
    call.consequential ||
    (!call.viaConnector && outsideRunToolRequiresApproval("webhook", call.name));
  if (!outward || !(await runCameByToken(ctx as RunContext))) return plan;
  const target = call.args.bot_id;
  if (DELEGATING_TOOLS.has(call.name) && typeof target === "string")
    await ctx.deps.prisma.$executeRaw`
      INSERT INTO dozo_token_taints ("spaceId", "botId", "fromRunId")
      SELECT ${ctx.run.spaceId}, b.id, ${ctx.run.id} FROM bots b
      WHERE b.id = ${target} AND b."spaceId" = ${ctx.run.spaceId}`;
  return "ask";
}

/**
 * An approval card in a run reached by a token's text: no Always allow, so no lasting rule comes
 * from it (the answer must be one of the card's actions), and a first line saying why it asks.
 */
export async function dozoTokenRunAsk(
  ctx: Pick<RunContext, "deps" | "run">,
  block: MessageBlock,
): Promise<MessageBlock> {
  if (block.kind !== "ask" || !(await runCameByToken(ctx))) return block;
  return {
    ...block,
    detail: block.detail ? `${DOZO_TOKEN_CARD_REASON}\n\n${block.detail}` : DOZO_TOKEN_CARD_REASON,
    ...(block.actions ? { actions: block.actions.filter((action) => action.id !== "always") } : {}),
  };
}
