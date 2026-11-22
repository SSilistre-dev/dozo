import type { MessageBlock } from "@rakazo/contracts";
import {
  approvalModeFromPreference,
  literalCommandWords,
  readOnlyCwd,
  readOnlyPipeline,
  redactSecrets,
} from "@rakazo/core";
import { buildApprovalAskBlock as buildUpstreamAskBlock } from "./approval-ask.js";
import {
  commandAsked,
  commandRuleMatch,
  HOSTED_SHELL_TOOL,
  markCommandAsk,
} from "./dozo-command-gate.js";
import { isPhoneTool, phoneCard, phoneGate } from "./dozo-phone.js";
import { dozoSendLimitCard } from "./dozo-send-limit.js";
import { isUserBrowserTool, userBrowserAsk, userBrowserGate } from "./dozo-user-browser-gate.js";
import type { RunContext } from "./run-context.js";
import {
  USER_COMPUTER_SHELL_TOOL,
  userComputerGate as upstreamUserComputerGate,
} from "./run-tools-user-computer.js";

export { isPhoneTool } from "./dozo-phone.js";
export { routesToUserBrowser } from "./dozo-user-browser-gate.js";

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
  // The user's phone has its own approval (dozo-phone.ts).
  if (isPhoneTool(name)) return phoneGate(ctx, blocked, name, args);
  // The page tools reach this gate only when they go to the user's own browser.
  if (isUserBrowserTool(name)) return userBrowserGate(ctx, blocked, name, args);
  const plan = await upstreamUserComputerGate(ctx, blocked, name, args);
  if (plan === "deny" || name !== USER_COMPUTER_SHELL_TOOL) return plan;
  const ruled = await commandRuleMatch(ctx, args, "user");
  if (ruled === "block") return "deny";
  if (plan !== "allow") return plan;
  if (approvalModeFromPreference(await ctx.trust.loadAutoReviewPreference()) === "never")
    return "allow";
  if (readOnlyCwd(args.cwd) && readOnlyPipeline(String(args.command ?? ""))) return "allow";
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
  if (isPhoneTool(toolName)) return phoneCard(effectId, toolName, args, secrets);
  const browserAsk = userBrowserAsk(args);
  if (browserAsk) return userBrowserCard(effectId, toolName, args, secrets, browserAsk);
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

/**
 * The card for the bot's own browser on the user's computer: its first use in a thread, or the
 * first time it opens, reads or acts on a site there, named by its registrable domain. The detail
 * shows the address or the steps.
 */
function userBrowserCard(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: Parameters<typeof buildUpstreamAskBlock>[3],
  ask: NonNullable<ReturnType<typeof userBrowserAsk>>,
): MessageBlock {
  // What it would do: the address it opens, or the steps it takes (text it types included).
  const doing =
    toolName === "browser_navigate"
      ? String(args.url)
      : toolName === "browser_act"
        ? JSON.stringify(args.actions)
        : "";
  const detail = redactSecrets(doing, secrets).slice(0, 2000);
  // What the page tool would do on the site, as its card says it.
  // What the call would do on the site, as its card says it; the first card names it too.
  const place = ask.site || "this page";
  const does =
    ask.verb === "signin"
      ? `have you sign in to ${place}`
      : `${ask.verb === "act" ? "act on" : ask.verb} ${place}`;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: ask.browser
      ? `Let this bot use its own browser on your computer${ask.site ? ` and ${does}` : ""}?`
      : `Let this bot ${does} in its browser?`,
    ...(detail ? { detail, detailFormat: "code" as const } : {}),
    status: "pending",
    actions: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
  };
}
