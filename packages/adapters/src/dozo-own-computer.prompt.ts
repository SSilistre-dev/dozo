/**
 * Where a person turns on their own computer in the Dozo desktop app: its app menu, not a
 * settings page. One source for every line that tells a bot or a user how to connect it.
 */
export const CONNECT_OWN_COMPUTER =
  'open the Dozo app menu and turn on "Let Bots Use This Computer"';

/** The line a bot reads when the task needs the user's computer and it is not connected. */
export const USER_COMPUTER_OFFLINE = `The user's computer is not connected. If the task needs it, ask them to ${CONNECT_OWN_COMPUTER}.`;
