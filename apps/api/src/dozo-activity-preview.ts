/**
 * The prompt the activity list may show for a run. The server writes some prompts itself to wake
 * the bot: the creation intro (`created`), the turn after a call ends (`call_end`) and the turn
 * after a connector is approved (`user` with no message behind it). Those are instructions to the
 * bot, which the chat and its export never show either, so their row shows no prompt.
 */
export function dozoActivityPrompt(run: {
  trigger: string;
  prompt: string;
  sourceMessageId: string | null;
}): string {
  if (run.trigger === "created" || run.trigger === "call_end") return "";
  if (run.trigger === "user" && run.sourceMessageId === null) return "";
  return run.prompt;
}
