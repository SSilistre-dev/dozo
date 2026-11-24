import { t } from "@lingui/core/macro";

/** The label of an approval card's "always" when the server says it allows one command. */
export function dozoAlwaysAllowLabel(serverLabel: string): string | undefined {
  return serverLabel === "Always allow this command" ? t`Always allow this command` : undefined;
}

/** The label of Allow for this run, the card answer for input on the bot's screen. */
export function dozoRunAllowLabel(id: string): string | undefined {
  return id === "allow_run" ? t`Allow for this run` : undefined;
}
