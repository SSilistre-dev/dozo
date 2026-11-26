import type { AuthMode } from "./auth/auth-routing";

/**
 * Code-first sign-in on mobile. A server that can email a code asks for the code before a password:
 * sign-up has no password at all, because a link-verified password account can only finish in the
 * browser that opened the link, which the app never is. Anchored rules in app/sign-in.tsx call
 * these; on a server without codes the screen is upstream's.
 */

/** The code form is shown unless the person chose a password for sign-in. */
export function usesCode(
  codeFlow: boolean,
  mode: AuthMode,
  codeSent: boolean,
  passwordChosen: boolean,
): boolean {
  return codeFlow && (codeSent || mode === "up" || !passwordChosen);
}

export function passwordShown(mode: AuthMode, usingCode: boolean): boolean {
  return mode !== "forgot" && !usingCode;
}

/** The server refused a password sign-in because the account's email was never confirmed. */
export function isUnverifiedSignIn(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    error.status === 403 &&
    "code" in error &&
    error.code === "EMAIL_NOT_VERIFIED"
  );
}

/** True when the sign-in was refused as unverified, so a code should be sent; other errors pass on. */
export async function signInNeedsCode(codeFlow: boolean, run: () => Promise<unknown>) {
  try {
    await run();
    return false;
  } catch (error) {
    if (codeFlow && isUnverifiedSignIn(error)) return true;
    throw error;
  }
}
