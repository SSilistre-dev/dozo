/** What the Dozo desktop app answers to a screen request (`NO_SCREEN` in its device runner). */
export const COMPUTER_NO_SCREEN_REPLY = "Screen control is not available on this computer.";

/** What the bot is told when its screen request is refused for that reason. */
export const COMPUTER_NO_SCREEN_RESULT =
  "This computer has no screen control in this app, and no permission or setting turns it on. You can only run commands on it. Do not ask the user to grant permissions or change settings, and do not offer to type or click there; the user does that themselves.";

/** The error text for a screen request the user's computer did not finish. */
export function screenFailureMessage(reason: string): string {
  return reason === COMPUTER_NO_SCREEN_REPLY
    ? COMPUTER_NO_SCREEN_RESULT
    : `The user's computer did not finish: ${reason}`;
}
