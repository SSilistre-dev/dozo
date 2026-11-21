import type { MessageBlock } from "@rakazo/contracts";
import {
  approvalModeFromPreference,
  commandRuleCwd,
  literalCommandWords,
  readOnlyPipeline,
} from "@rakazo/core";
import { dozoCommandRuleExists } from "@rakazo/db";
import { buildApprovalAskBlock as buildUpstreamAskBlock } from "./approval-ask.js";
import { dozoSendLimitCard } from "./dozo-send-limit.js";
import type { RunContext } from "./run-context.js";
import {
  USER_COMPUTER_SHELL_TOOL,
  userComputerGate as upstreamUserComputerGate,
} from "./run-tools-user-computer.js";

/** The calls this gate asked about one by one, so their card asks about the command alone. */
const commandAsks = new WeakSet<Record<string, unknown>>();

/**
 * The user's own computer, as upstream gates it, and then each command once the Space allows the
 * computer: a command that only reads, or that the member always allows this bot to run in that
 * folder, goes ahead; any other asks. Never ask keeps the Space-wide approval alone.
 */
export async function userComputerGate(
  ctx: RunContext,
  blocked: boolean,
  name: string,
  args: Record<string, unknown>,
): Promise<"deny" | "allow" | "ask"> {
  const plan = await upstreamUserComputerGate(ctx, blocked, name, args);
  if (plan !== "allow" || name !== USER_COMPUTER_SHELL_TOOL) return plan;
  if (approvalModeFromPreference(await ctx.trust.loadAutoReviewPreference()) === "never")
    return "allow";
  const words = literalCommandWords(String(args.command ?? ""));
  if (readOnlyPipeline(String(args.command ?? ""))) return "allow";
  const ruled =
    words &&
    (await dozoCommandRuleExists(ctx.deps.prisma, {
      userId: ctx.run.userId,
      botId: ctx.bot.id,
      words,
      cwd: commandRuleCwd(args.cwd),
    }));
  if (ruled) return "allow";
  commandAsks.add(args);
  return "ask";
}

/**
 * Upstream's card, except for a command asked about on its own: Allow once, Deny, and Always allow
 * this command when the card shows the whole command as it will be saved. A send held for the
 * daily limit says so (dozo-send-limit.ts).
 */
export function buildApprovalAskBlock(
  ...input: Parameters<typeof buildUpstreamAskBlock>
): MessageBlock {
  const [effectId, toolName, args, secrets, options] = input;
  const block = buildUpstreamAskBlock(
    effectId,
    toolName,
    args,
    secrets,
    dozoSendLimitCard(args, options),
  );
  if (toolName !== USER_COMPUTER_SHELL_TOOL || !commandAsks.has(args) || block.kind !== "ask")
    return block;
  const command = String(args.command ?? "");
  // As upstream's card writes it, so a redacted or shortened command is never saved unseen.
  const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
  const shown = block.detail === `${cwd ? `cd ${cwd}\n` : ""}${command}`;
  return {
    ...block,
    actions: [
      { id: "allow", label: "Allow once" },
      ...(shown && literalCommandWords(command)
        ? [{ id: "always", label: "Always allow this command" }]
        : []),
      { id: "deny", label: "Deny" },
    ],
  };
}
