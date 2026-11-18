import type { AuthMode } from "./auth-routing";

/**
 * Closed registration on the sign-in screen. The server says in its public capabilities whether
 * new accounts can register (`signupsOpen`, a field only a Dozo server sends). The screen reads the
 * capabilities again whenever the server changes, so these follow a custom server too. Anchored
 * rules in app/sign-in.tsx call them; with the field missing or true the screen is upstream's.
 */

/** True only when the server answered that registration is closed. */
export function signupsAreClosed(capabilities: object | null): boolean {
  return (
    capabilities !== null && "signupsOpen" in capabilities && capabilities.signupsOpen === false
  );
}

/** The form to show: sign-up becomes sign-in on a server that takes no new accounts. */
export function authModeFor(requested: AuthMode, capabilities: object | null): AuthMode {
  return requested === "up" && signupsAreClosed(capabilities) ? "in" : requested;
}

/** The sign-up title waits for the server's answer, so a closed server never shows it. */
export function titleWhenKnown(known: unknown, title: string): string {
  return known ? title : "";
}
