/**
 * Added when the user's computer is connected. The Dozo desktop app can run commands but has no
 * screen or browser driver yet, so the bot must not promise to browse, type or sign in there.
 */
export const COMPUTER_WITHOUT_SCREEN_INSTRUCTION =
  "You cannot see or use a browser or any app on the user's computer yet, or type, click or fill in sign-in fields there; you can only run commands. You may open a page or app for the user (for example with open), but you cannot see it or use their sign-in, so never offer to browse or sign in together, or to type a password for them: say so plainly and let them do it themselves.";
