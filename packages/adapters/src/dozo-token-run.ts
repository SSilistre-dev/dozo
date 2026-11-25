import type { MessageBlock } from "@rakazo/contracts";
import { outsideRunToolRequiresApproval } from "@rakazo/core";
import type { DozoMarkDb } from "./dozo-token-marks.js";
import { dozoBotTokenTainted, dozoMarkBot } from "./dozo-token-marks.js";
import type { RunContext } from "./runs/assembly/run-context.js";
import { READ_ONLY_AGENT_TOOLS } from "./runs/tools/run-tool-selection.js";

export { dozoBotTokenTainted } from "./dozo-token-marks.js";

type TokenRun = {
  deps: { prisma: DozoMarkDb };
  run: { id: string; botId: string; threadId: string; spaceId: string };
};

/** Runs known to have been reached by a token's text. Only a yes is kept: one can still arrive. */
const tokenRuns = new WeakSet<object>();

/**
 * Builtin tools that name another bot to message, change or wake, and every argument name their
 * handlers read for it. In a marked run each must be a string: a handler that turns another value
 * into one could reach a bot nobody saw named on the card.
 */
const TARGET_ARGS: Record<string, readonly string[]> = {
  message_bot: ["bot_id", "confirm_name"],
  handoff_to_bot: ["bot_id", "confirm_name", "group_id"],
  archive_bot: ["bot_id", "confirm_name", "botId", "confirmName"],
  update_bot: ["bot_id"],
  set_child_instructions: ["bot_id", "bot_name"],
  set_child_bot_model: ["bot_id", "bot_name"],
  create_child_routine: ["bot_id", "bot_name"],
  organize_bot: ["bot_id", "bot_name", "group_id", "group_name"],
  create_group: ["bot_ids", "bot_names"],
  update_group: ["group_id", "group_name", "add_bot_ids", "remove_bot_ids"],
  ticket_create: ["ownerBotId"],
  ticket_update: ["ownerBotId"],
};

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

/** dozoBotTokenTainted for a running run, remembered once true. */
export async function runCameByToken(ctx: Pick<RunContext, "deps" | "run">): Promise<boolean> {
  if (tokenRuns.has(ctx)) return true;
  const sourced = await dozoBotTokenTainted(ctx.deps.prisma, ctx.run);
  if (sourced) tokenRuns.add(ctx);
  return sourced;
}

/** The target arguments that take a list of bots; every other one names one. */
const LIST_ARGS = new Set(["bot_ids", "bot_names", "add_bot_ids", "remove_bot_ids"]);

const isTargetValue = (key: string, value: unknown) =>
  value === undefined ||
  (LIST_ARGS.has(key)
    ? Array.isArray(value) && value.every((item) => typeof item === "string")
    : typeof value === "string");

/**
 * The gate's plan, except in a run reached by a token's text: every call that is not a plain read
 * asks the person, whatever the approval mode, rules or review would do. That is upstream's set
 * for webhook runs (builtins outside OUTSIDE_RUN_SAFE_BUILTIN_TOOLS: the computer, the browser,
 * files, memory, settings, other bots, routines) less the builtins upstream runs as reads, plus
 * every call upstream already counts as consequential (sends, connector writes, the user's own
 * computer) and the reads in ASKING_READS. A refusal stays a refusal, and a call naming another bot
 * by anything but a string is refused. The gate only asks: what a call reaches is marked when it
 * runs (dozo-token-marks.ts, dozoTokenRunDone), so a call the person denies leaves no mark.
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
  const targets = builtin ? TARGET_ARGS[call.name] : undefined;
  if (targets?.some((key) => !isTargetValue(key, call.args[key]))) return "deny";
  return "ask";
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * After a call ran in a marked run, and only when it succeeded (also when its result is replayed
 * after a restart): marks the bot it wrote to, from what the handler reports it reached. A bot whose
 * instructions it set, or that a ticket it wrote now belongs to, is marked; a bot it spawned, or the
 * bot of a routine it made or changed, is marked for good, tied to that routine.
 */
export async function dozoTokenRunDone(
  ctx: TokenRun,
  name: string,
  args: Record<string, unknown>,
  result: unknown,
): Promise<void> {
  const made = record(result);
  if (!made || "error" in made) return;
  const writes = ["set_child_instructions", "update_bot", "ticket_create", "ticket_update"];
  if (!MAKING_TOOLS.has(name) && !writes.includes(name)) return;
  if (!(await runCameByToken(ctx as RunContext))) return;
  const db = ctx.deps.prisma;
  const space = ctx.run.spaceId;
  const mark = (botId: unknown) =>
    typeof botId === "string" && botId !== ctx.run.botId
      ? dozoMarkBot(db, { spaceId: space, botId, fromRunId: ctx.run.id })
      : undefined;
  if (name === "set_child_instructions") return mark(made.botId);
  if (name === "update_bot") return mark(args.bot_id);
  if (name === "ticket_create" || name === "ticket_update")
    return mark(record(made.ticket)?.assigneeBotId);
  if (name === "spawn_bot") {
    if (typeof made.botId !== "string") return;
    await db.$executeRaw`
      INSERT INTO dozo_token_taints ("spaceId", "botId", lasting, "fromRunId")
      SELECT ${space}, b.id, true, ${ctx.run.id} FROM bots b
      WHERE b.id = ${made.botId} AND b."spaceId" = ${space}
      ON CONFLICT ("botId") WHERE "lasting" AND "routineId" IS NULL DO NOTHING`;
    return;
  }
  if (typeof made.routineId !== "string") return;
  await db.$executeRaw`
    INSERT INTO dozo_token_taints ("spaceId", "botId", "routineId", lasting, "fromRunId")
    SELECT ${space}, r."botId", r.id, true, ${ctx.run.id} FROM routines r
    WHERE r.id = ${made.routineId} AND r."spaceId" = ${space}
    ON CONFLICT ("routineId") WHERE "routineId" IS NOT NULL DO NOTHING`;
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
