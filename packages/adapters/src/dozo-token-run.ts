import type { MessageBlock } from "@rakazo/contracts";
import { DOZO_TOKEN_NONCE_PREFIX } from "@rakazo/core";
import type { RunContext } from "./run-context.js";

/** Runs known to have taken in a message sent with a token. Only a yes is kept: a later one can still arrive. */
const tokenRuns = new WeakSet<RunContext>();

/**
 * Whether a message sent with a personal access token started this run, steered into it, or
 * answered it. Text from a token may come from another program or agent, so it is never treated
 * as the owner's own request (dozo-token-source.ts).
 */
export async function runCameByToken(ctx: Pick<RunContext, "deps" | "runId">): Promise<boolean> {
  const key = ctx as RunContext;
  if (tokenRuns.has(key)) return true;
  const rows = await ctx.deps.prisma.$queryRaw<{ sourced: boolean }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM runs r JOIN messages m ON m.id = r."sourceMessageId"
        WHERE r.id = ${ctx.runId} AND starts_with(m."clientNonce", ${DOZO_TOKEN_NONCE_PREFIX}))
      OR EXISTS (SELECT 1 FROM messages m
        WHERE m."runId" = ${ctx.runId} AND m.role = 'user'
          AND starts_with(m."clientNonce", ${DOZO_TOKEN_NONCE_PREFIX}))
      OR EXISTS (SELECT 1 FROM steering_messages s JOIN messages m ON m.id = s."messageId"
        WHERE s."runId" = ${ctx.runId} AND s."claimedAt" IS NOT NULL
          AND starts_with(m."clientNonce", ${DOZO_TOKEN_NONCE_PREFIX}))
    ) AS sourced`;
  const sourced = rows[0]?.sourced === true;
  if (sourced) tokenRuns.add(key);
  return sourced;
}

/**
 * The gate's plan, except in a run a token's message reached: an action with an outside effect
 * (sending, a connector write, a command on the user's own computer) asks the person, whatever the
 * Space's approval mode, rules or review would do. A refusal stays a refusal.
 */
export async function dozoTokenRunPlan<Plan extends string>(
  ctx: Pick<RunContext, "deps" | "runId">,
  consequential: boolean,
  plan: Plan,
): Promise<Plan | "ask"> {
  if (!consequential || plan === "deny" || plan === "ask") return plan;
  return (await runCameByToken(ctx)) ? "ask" : plan;
}

/** An approval card without "Always allow" in a run a token's message reached: no lasting rule from it. */
export async function dozoTokenRunAsk(
  ctx: Pick<RunContext, "deps" | "runId">,
  block: MessageBlock,
): Promise<MessageBlock> {
  if (block.kind !== "ask" || !block.actions?.some((action) => action.id === "always"))
    return block;
  if (!(await runCameByToken(ctx))) return block;
  return { ...block, actions: block.actions.filter((action) => action.id !== "always") };
}
