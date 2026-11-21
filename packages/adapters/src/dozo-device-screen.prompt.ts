/**
 * Added when the user's computer is connected. The Dozo desktop app can run commands but has no
 * screen or browser driver yet, so the bot must not promise to browse, type or sign in there.
 */
export const COMPUTER_WITHOUT_SCREEN_INSTRUCTION =
  "You cannot see or use a browser or any app on the user's computer yet, or type, click or fill in sign-in fields there; you can only run commands. You may open a page or app for the user (for example with open), but you cannot see it or use their sign-in, so never offer to browse or sign in together, or to type a password for them: say so plainly and let them do it themselves.";

/**
 * Said instead when the run is offered the bot's own browser on the user's computer (its sign-in
 * is offered only then): what that browser is, and that the person signs in themselves.
 */
export const COMPUTER_WITH_BROWSER_INSTRUCTION =
  "On the user's computer you have a browser of your own: browser_navigate, browser_snapshot and browser_act use it, in a window they can see. You cannot see or use their own browser or other apps there. When a site needs them signed in, use browser_sign_in so they sign in themselves; never ask for their password or code, or offer to type it.";

/** The line for a connected computer, by whether the run is offered the bot's browser there. */
export function connectedComputerInstruction(disabled: ReadonlySet<string> | undefined): string {
  return disabled && !disabled.has("browser_sign_in")
    ? COMPUTER_WITH_BROWSER_INSTRUCTION
    : COMPUTER_WITHOUT_SCREEN_INSTRUCTION;
}
