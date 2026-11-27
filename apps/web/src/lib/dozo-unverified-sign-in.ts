/**
 * A password sign-in the server refused because the account's email was never confirmed. The page
 * then mails a code, which confirms the address in this browser; any other refusal, a wrong
 * password included, is only shown.
 */
export function isUnverifiedSignIn(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 403 &&
    "code" in error &&
    error.code === "EMAIL_NOT_VERIFIED"
  );
}
