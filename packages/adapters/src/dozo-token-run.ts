import type { MessageBlock } from "@rakazo/contracts";
import { outsideRunToolRequiresApproval } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { RunContext } from "./run-context.js";
import { READ_ONLY_AGENT_TOOLS } from "./run-tool-selection.js";

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;
type TokenRun = {
  deps: { prisma: Db };
  run: { id: string; botId: string; threadId: string; spaceId: string };
};

/** Runs known to have been reached by a token's text. Only a yes is kept: one can still arrive. */
const tokenRuns = new WeakSet<object>();

/**
 * Builtin tools that message, wake, change or group another bot. Their arguments name it by id or
 * by name, as their handlers accept; the bots they reach are marked too, so the work a token's text
 * hands on is asked about there as well.
 */
const REACHING_TOOLS = new Set([
  "message_bot",
  "handoff_to_bot",
  "archive_bot",
  "update_bot",
  "set_child_instructions",
  "set_child_bot_model",
  "create_child_routine",
  "organize_bot",
  "create_group",
  "update_group",
  "ticket_create",
  "ticket_update",
]);
const BOT_ID_ARGS = ["bot_id", "ownerBotId", "bot_ids", "add_bot_ids"];
const BOT_NAME_ARGS = ["confirm_name", "bot_name", "bot_names"];

/** Builtin tools whose result is new work that outlives the run: it keeps the mark for good. */
const MAKING_TOOLS = new Set([
  "spawn_bot",
  "schedule_create",
  "schedule_update",
  "create_child_routine",
]);

/** Reads that still ask in a marked run: contact details are returned whole. */
const ASKING_READS = new Set(["list_secrets"]);

/** The card says why it asks, and for work that outlives the run, that the mark does too. */
export const DOZO_TOKEN_CARD_REASON = "Asked by a message sent with an access token";
export const DOZO_TOKEN_CARD_LASTING =
  "What this makes keeps asking before it acts until it is deleted";

/**
 * Whether a run's bot holds text that came in with a personal access token (dozo-token-source.ts):
 * a message sent with one in the bot's chat or the run's own chat, still there (clearing the chat
 * removes it); a mark left when a marked run of another bot reached this one, until this bot's
 * chat is cleared after it, or for good when the mark lasts (a bot or routine a marked run made);
 * or the same for a bot it was spawned from. Text from a token may come from another program or
 * agent, so it is never treated as the owner's own request, and the history it stays in keeps
 * every later run of the bot asking.
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
        WHERE x.lasting OR NOT EXISTS (SELECT 1 FROM threads t JOIN events e ON e."threadId" = t.id
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

const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];

/**
 * The bots a reaching call names, by id or by name (any case, any bot of the run's Space, so every
 * bot a handler could pick is among them), and the members of the group it names. Null when a
 * name or id matches no bot or group: the handler cannot reach one either, so the call is refused
 * rather than let through unmarked.
 */
export async function reachedBots(
  ctx: TokenRun,
  args: Record<string, unknown>,
): Promise<string[] | null> {
  const db = ctx.deps.prisma;
  const space = ctx.run.spaceId;
  const found = new Set<string>();
  const add = (rows: { id: string | null }[]) => {
    for (const row of rows) if (row.id) found.add(row.id);
    return rows.length > 0;
  };
  for (const id of BOT_ID_ARGS.flatMap((key) => strings(args[key]))) {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM bots WHERE id = ${id} AND "spaceId" = ${space}`;
    if (!add(rows)) return null;
  }
  for (const name of BOT_NAME_ARGS.flatMap((key) => strings(args[key]))) {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM bots WHERE lower(name) = lower(${name.trim()}) AND "spaceId" = ${space}`;
    if (!add(rows)) return null;
  }
  for (const id of strings(args.group_id)) {
    const rows = await db.$queryRaw<{ id: string | null }[]>`
      SELECT m."botId" AS id FROM chat_groups g
      LEFT JOIN chat_group_members m ON m."groupId" = g.id
      WHERE g.id = ${id} AND g."spaceId" = ${space}`;
    if (!add(rows)) return null;
  }
  for (const name of strings(args.group_name)) {
    const rows = await db.$queryRaw<{ id: string | null }[]>`
      SELECT m."botId" AS id FROM chat_groups g
      LEFT JOIN chat_group_members m ON m."groupId" = g.id
      WHERE lower(g.name) = lower(${name.trim()}) AND g."spaceId" = ${space}`;
    if (!add(rows)) return null;
  }
  found.delete(ctx.run.botId);
  return [...found];
}

/**
 * The gate's plan, except in a run reached by a token's text: every call that is not a plain read
 * asks the person, whatever the approval mode, rules or review would do. That is upstream's set
 * for webhook runs (builtins outside OUTSIDE_RUN_SAFE_BUILTIN_TOOLS: the computer, the browser,
 * files, memory, settings, other bots, routines) less the builtins upstream runs as reads, plus
 * every call upstream already counts as consequential (sends, connector writes, the user's own
 * computer) and the reads in ASKING_READS. A refusal stays a refusal. A call that reaches other
 * bots marks them before it is asked about, and is refused when it names one that does not exist.
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
): Promise<Plan | "ask" | "deny"> {
  if (plan === "deny") return plan;
  const builtin = !call.viaConnector;
  const outward =
    call.consequential ||
    (builtin && ASKING_READS.has(call.name)) ||
    (builtin &&
      outsideRunToolRequiresApproval("webhook", call.name) &&
      !READ_ONLY_AGENT_TOOLS.has(call.name));
  if (!outward || !(await runCameByToken(ctx as RunContext))) return plan;
  if (builtin && REACHING_TOOLS.has(call.name)) {
    const bots = await reachedBots(ctx, call.args);
    if (!bots) return "deny";
    for (const botId of bots)
      await ctx.deps.prisma.$executeRaw`
        INSERT INTO dozo_token_taints ("spaceId", "botId", "fromRunId")
        VALUES (${ctx.run.spaceId}, ${botId}, ${ctx.run.id})`;
  }
  return "ask";
}

/**
 * After a making call ran in a marked run, marks what it made for good: the bot it spawned, or the
 * bot of the routine it made or changed, tied to that routine. Nothing for any other call or run.
 */
export async function dozoTokenRunMade(
  ctx: TokenRun,
  name: string,
  args: Record<string, unknown>,
  result: unknown,
): Promise<void> {
  if (!MAKING_TOOLS.has(name) || !(await runCameByToken(ctx as RunContext))) return;
  const made = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const space = ctx.run.spaceId;
  if (name === "spawn_bot") {
    if (typeof made.botId !== "string") return;
    await ctx.deps.prisma.$executeRaw`
      INSERT INTO dozo_token_taints ("spaceId", "botId", lasting, "fromRunId")
      SELECT ${space}, b.id, true, ${ctx.run.id} FROM bots b
      WHERE b.id = ${made.botId} AND b."spaceId" = ${space}`;
    return;
  }
  const routineId = typeof made.routineId === "string" ? made.routineId : args.routineId;
  if (typeof routineId !== "string") return;
  await ctx.deps.prisma.$executeRaw`
    INSERT INTO dozo_token_taints ("spaceId", "botId", "routineId", lasting, "fromRunId")
    SELECT ${space}, r."botId", r.id, true, ${ctx.run.id} FROM routines r
    WHERE r.id = ${routineId} AND r."spaceId" = ${space}`;
}

/**
 * An approval card in a run reached by a token's text: no Always allow, so no lasting rule comes
 * from it (the answer must be one of the card's actions), a first line saying why it asks, and for
 * a call that makes lasting work, a second saying the mark lasts too.
 */
export async function dozoTokenRunAsk(
  ctx: Pick<RunContext, "deps" | "run">,
  name: string,
  block: MessageBlock,
): Promise<MessageBlock> {
  if (block.kind !== "ask" || !(await runCameByToken(ctx))) return block;
  const why = MAKING_TOOLS.has(name)
    ? `${DOZO_TOKEN_CARD_REASON}\n${DOZO_TOKEN_CARD_LASTING}`
    : DOZO_TOKEN_CARD_REASON;
  return {
    ...block,
    detail: block.detail ? `${why}\n\n${block.detail}` : why,
    ...(block.actions ? { actions: block.actions.filter((action) => action.id !== "always") } : {}),
  };
}
