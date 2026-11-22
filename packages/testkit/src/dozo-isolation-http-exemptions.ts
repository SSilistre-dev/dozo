/**
 * What the HTTP isolation test does not call the generic way, each with the reason. A raw route
 * listed here that the app no longer registers, and an auth endpoint here the auth library no
 * longer answers, fail the test, so a stale entry is removed.
 */
export type HttpExemption = { route: string; reason: string };

/** Raw routes (`METHOD /path`, as the app registers them) not called with generated requests. */
export const HTTP_ROUTE_EXEMPTIONS: readonly HttpExemption[] = [
  {
    route: "GET /api/auth/*",
    reason:
      "The auth library's one wildcard: called endpoint by endpoint (AUTH_ENDPOINTS in the test), since a generated path only reaches its 404.",
  },
  {
    route: "POST /api/auth/*",
    reason:
      "The auth library's one wildcard: called endpoint by endpoint (AUTH_ENDPOINTS in the test), since a generated path only reaches its 404.",
  },
];

/**
 * Auth endpoints never called with B's session: each acts on the caller's own account only and
 * would end or change the session the rest of the test signs in with. They name no target, so a
 * foreign id cannot reach them; each is still called anonymously to prove it exists.
 */
export const AUTH_ENDPOINT_EXEMPTIONS: readonly HttpExemption[] = [
  { route: "POST /api/auth/sign-out", reason: "ends the caller's own session" },
  { route: "POST /api/auth/revoke-sessions", reason: "ends every session of the caller" },
  { route: "POST /api/auth/revoke-other-sessions", reason: "ends the caller's other sessions" },
  { route: "POST /api/auth/delete-user", reason: "deletes the caller's own account" },
  {
    route: "POST /api/auth/request-account-deletion",
    reason: "starts deleting the caller's own account",
  },
  { route: "POST /api/auth/change-password", reason: "changes the caller's own password" },
  { route: "POST /api/auth/change-email", reason: "changes the caller's own address" },
  { route: "POST /api/auth/update-user", reason: "renames the caller's own account" },
  {
    route: "POST /api/auth/confirm-identity",
    reason:
      "the caller's own password; a wrong one counts toward the caller's lockout, and the world signs in through it",
  },
];
