import type { MessageBlock } from "@rakazo/contracts";
import { approvalModeFromPreference, literalCommandWords, readOnlyPipeline } from "@rakazo/core";
import { buildApprovalAskBlock as buildUpstreamAskBlock } from "./approval-ask.js";
import {
  commandAsked,
  commandRuleMatch,
  HOSTED_SHELL_TOOL,
  markCommandAsk,
} from "./dozo-command-gate.js";
import { dozoSendLimitCard } from "./dozo-send-limit.js";
import type { RunContext } from "./run-context.js";
import {
  USER_COMPUTER_SHELL_TOOL,
  userComputerGate as upstreamUserComputerGate,
} from "./run-tools-user-computer.js";

/**
 * The user's own computer, as upstream gates it, and then each command: a block rule refuses it in
 * every mode, also before the Space allows the computer. Once the Space allows it, a command that
 * only reads, or that the member allows this bot to run in that folder, goes ahead; any other asks.
 * Never ask keeps the Space-wide approval alone.
 */
export async function userComputerGate(
  ctx: RunContext,
  blocked: boolean,
  name: string,
  args: Record<string, unknown>,
): Promise<"deny" | "allow" | "ask"> {
  const plan = await upstreamUserComputerGate(ctx, blocked, name, args);
  if (plan === "deny" || name !== USER_COMPUTER_SHELL_TOOL) return plan;
  const ruled = await commandRuleMatch(ctx, args, "user");
  if (ruled === "block") return "deny";
  if (plan !== "allow") return plan;
  if (approvalModeFromPreference(await ctx.trust.loadAutoReviewPreference()) === "never")
    return "allow";
  if (readOnlyPipeline(String(args.command ?? ""))) return "allow";
  if (ruled) return "allow";
  markCommandAsk(args);
  return "ask";
}

/**
 * Upstream's card, except for a command asked about on its own, and for every command on the bot's
 * computer: Allow once, Deny, and Always allow this command when the card shows the whole command as
 * it will be saved. A send held for the daily limit says so (dozo-send-limit.ts).
 */
export function buildApprovalAskBlock(
  ...input: Parameters<typeof buildUpstreamAskBlock>
): MessageBlock {
  const [effectId, toolName, args, secrets, options] = input;
  const hosted = toolName === HOSTED_SHELL_TOOL;
  const block = hosted
    ? // Written as upstream writes a command for the user's own computer, under its own question.
      {
        ...buildUpstreamAskBlock(effectId, USER_COMPUTER_SHELL_TOOL, args, secrets),
        text: "Run on the bot's computer?",
      }
    : buildUpstreamAskBlock(effectId, toolName, args, secrets, dozoSendLimitCard(args, options));
  if (
    block.kind !== "ask" ||
    !(hosted || (toolName === USER_COMPUTER_SHELL_TOOL && commandAsked(args)))
  )
    return block;
  const command = String(args.command ?? "");
  // As the card writes it, so a redacted or shortened command is never saved unseen.
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
