/**
 * Where a verification link lands once the server has checked it: the web app's result page
 * (`apps/web/src/pages/dozo-email-link.tsx`). The auth library appends `error=<code>` when the link
 * did not verify. The address rides along so the page can fill the sign-in or resend form; the page
 * drops it from the address bar at once.
 */
export function verificationCallbackUrl(webOrigin: string, email: string): string {
  const url = new URL("/verify-email", webOrigin);
  url.searchParams.set("email", email);
  return url.href;
}
