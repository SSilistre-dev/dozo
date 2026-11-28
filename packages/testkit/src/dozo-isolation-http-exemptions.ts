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

/**
 * What each raw route and called auth endpoint returns, so the owner control knows which must show
 * the owner's data. Every route the app registers and every endpoint in AUTH_ENDPOINTS is listed
 * once; an unlisted one, or an entry for one that is gone, fails the test.
 *
 * - `owner-data`: returns the owner's data. The owner's own call with the same generated request
 *   must show a canary (`session` or `token` names the owner's credential), so a foreign refusal
 *   of that request is a refusal and not a request that reaches nothing.
 * - `real-arguments`: returns or changes the owner's data only with arguments a generated request
 *   cannot carry; the named test calls it with the real ones, as the owner and as B.
 * - `bearer-link`: answers whoever holds a secret token from a link; a foreign caller cannot have
 *   it, and the generated request carries a foreign id where the token goes.
 * - `write`: changes things and answers with no tenant data; the snapshot catches a foreign write.
 * - `public`: the same answer for every caller, from configuration or a constant.
 * - `own-account`: the caller's own account only; the owner's answer names the owner (`session`),
 *   and a foreign call that named A would show A's id or address.
 * - `nameless`: the caller's own flags or an empty list, naming no one: nothing the owner's
 *   answer could show that B's could leak.
 * - `not-served`: refuses the owner too in this app (a feature or plugin left off, or an endpoint
 *   for a kind of account the world has none of); the owner's call must be refused.
 */
export type RouteDataKind =
  | "owner-data"
  | "real-arguments"
  | "bearer-link"
  | "write"
  | "public"
  | "own-account"
  | "nameless"
  | "not-served";

export type RouteData = {
  route: string;
  kind: RouteDataKind;
  /** The owner's credential for the control call, for `owner-data` and `own-account`. */
  owner?: "session" | "token" | "apiKey";
  reason: string;
};

const ownerToken = (route: string, reason: string): RouteData => ({
  route,
  kind: "owner-data",
  owner: "token",
  reason,
});

/** The public API, answered for the person whose API key the request carries. */
const ownerApiKey = (route: string, reason: string): RouteData => ({
  route,
  kind: "owner-data",
  owner: "apiKey",
  reason,
});

export const ROUTE_DATA: readonly RouteData[] = [
  {
    route: "GET /api/audit-events/export",
    kind: "owner-data",
    owner: "session",
    reason: "the Space's audit events",
  },
  {
    route: "GET /api/devices",
    kind: "owner-data",
    owner: "session",
    reason: "the caller's paired computers",
  },
  ownerToken("GET /api/v1/dozo/bots", "the token's bots"),
  ownerToken("GET /api/v1/dozo/bots/:botId/chats", "a bot's chats"),
  ownerToken("GET /api/v1/dozo/bots/:botId/export", "a chat as Markdown"),
  ownerToken("GET /api/v1/dozo/bots/:botId/messages", "a chat's messages"),
  ownerToken("GET /api/v1/dozo/bots/:botId/runs/:runId/events", "a run's events in a chat"),
  ownerApiKey("GET /api/v1/models", "the bots of the key's person, in every Space"),
  ownerApiKey("GET /api/v1/tasks/:id", "a task of the key's person, with the bot's replies"),
  ownerApiKey("GET /api/v1/tasks/:id/events", "the same task as a stream, until it settles"),
  {
    route: "ALL /api/mcp",
    kind: "real-arguments",
    reason:
      "JSON-RPC tool calls with an API key: the public API test calls each tool as the owner and as B",
  },
  {
    route: "POST /api/v1/tasks",
    kind: "real-arguments",
    reason:
      "starts a task with a bot the body names by id or name: the public API test sends as the owner and as B",
  },
  {
    route: "POST /api/v1/tasks/:id/messages",
    kind: "real-arguments",
    reason:
      "a follow-up in a task, the text in a body field of its own: the public API test sends as the owner and as B",
  },
  {
    route: "POST /api/v1/chat/completions",
    kind: "real-arguments",
    reason:
      "an OpenAI-style chat with a bot as the model: the public API test sends as the owner and as B",
  },
  {
    route: "ALL /api/v1/dozo/mcp",
    kind: "real-arguments",
    reason: "JSON-RPC tool calls: the MCP test calls each tool as the owner and as B",
  },
  {
    route: "POST /api/v1/dozo/bots/:botId/messages",
    kind: "real-arguments",
    reason:
      "sends with the chat in the query and only text in the body: the bot API test sends as the owner and as B",
  },
  {
    route: "GET /api/account/export",
    kind: "bearer-link",
    reason: "a one-time export token issued to the signed-in user; the export test uses real ones",
  },
  {
    route: "GET /api/v1/dozo/shared/:token",
    kind: "bearer-link",
    reason:
      "public to whoever holds a share link, by design: only the token's hash is looked up, and every refusal is the same 404",
  },
  {
    route: "GET /api/v1/pages/shared/:token",
    kind: "bearer-link",
    reason: "public to whoever holds a page's share link, by design",
  },
  {
    route: "GET /api/v1/pages/shared/:token/images/:imageId",
    kind: "bearer-link",
    reason:
      "public to whoever holds a page's share link, for a picture its current version shows: the image is looked up under the token's own version, so another page's picture is a 404",
  },
  ...[
    ["GET /api/v1/page-app", "its page and what the owner approved it to do"],
    ["GET /api/v1/page-app/images/:imageId", "a picture of its page"],
    ["PUT /api/v1/page-app/state", "the owner's saved values on its page"],
    ["PUT /api/v1/page-app/abilities", "what the owner approved it to do"],
    ["POST /api/v1/page-app/ask", "a question to its page's bot"],
    ["DELETE /api/v1/page-app", "its own installation"],
    ["GET /api/v1/page-app/changes", "a stream of changes to its page"],
  ].map(
    ([route, what]): RouteData => ({
      route: route!,
      kind: "bearer-link",
      reason: `an installed page app's own token, issued once to its owner when installed: it reaches ${what} only, as the owner, in the Space it was installed from; no session, API key or other token opens it, and the generated request carries none`,
    }),
  ),
  {
    route: "GET /api/v1/pages/:pageId/app.webmanifest",
    kind: "owner-data",
    owner: "session",
    reason: "the title of the caller's own page, for installing it as an app",
  },
  {
    route: "GET /api/v1/pages/:pageId/app-icon/:file",
    kind: "nameless",
    reason:
      "a picture drawn from the page's icon and colour, named only by its file; the page is looked up under the caller's own tenant, so a foreign page's id is a 404",
  },
  {
    route: "GET /api/v1/integration-claims/confirm",
    kind: "bearer-link",
    reason: "a one-time token from an emailed link",
  },
  {
    route: "GET /api/v1/email/unsubscribe",
    kind: "bearer-link",
    reason: "a signed token bound to one user",
  },
  {
    route: "POST /api/v1/email/unsubscribe",
    kind: "bearer-link",
    reason: "a signed token bound to one user",
  },
  {
    route: "POST /api/account/import",
    kind: "write",
    reason: "imports an archive into the caller's own account",
  },
  {
    route: "DELETE /api/devices/:deviceId",
    kind: "write",
    reason: "removes a paired computer; the devices test holds B to 404 on A's",
  },
  { route: "DELETE /api/devices/self", kind: "write", reason: "a computer removes itself" },
  {
    route: "POST /api/devices/self/dozo-logins",
    kind: "write",
    reason:
      "a computer links a login of its own password manager into its owner's account vault; no value",
  },
  {
    route: "DELETE /api/devices/self/dozo-logins/:handle",
    kind: "write",
    reason: "a computer removes a login it linked; only its own links",
  },
  { route: "POST /api/devices/pair", kind: "write", reason: "pairs a computer to the caller" },
  {
    route: "POST /api/devices/self/session",
    kind: "write",
    reason: "ties a computer to the caller's sign-in; the devices test holds it to 403 across",
  },
  {
    route: "POST /api/desktop-settings/computer-host",
    kind: "write",
    reason: "the desktop app's own computer, answered with status only",
  },
  {
    route: "POST /api/internal/screen-target",
    kind: "write",
    reason: "the desktop app's own screen target",
  },
  {
    route: "POST /internal/user-devices/disconnect",
    kind: "write",
    reason: "a computer's own connection, by its token",
  },
  {
    route: "POST /internal/user-devices/request",
    kind: "write",
    reason: "a request to a computer, by the relay's credential",
  },
  {
    route: "POST /api/v1/bots/:botId/github",
    kind: "write",
    reason: "an inbound webhook signed with the bot's secret, answered with status only",
  },
  {
    route: "POST /api/v1/bots/:botId/webhook",
    kind: "write",
    reason: "an inbound webhook with the bot's secret, answered with status only",
  },
  {
    route: "POST /api/v1/plugin-submissions",
    kind: "write",
    reason: "a public plugin submission",
  },
  { route: "POST /api/csp-report", kind: "write", reason: "logs a browser's report" },
  {
    route: "POST /api/monitoring/tunnel",
    kind: "write",
    reason: "forwards an error report to the configured project",
  },
  {
    route: "POST /api/monitoring/native/:surface/api/0/envelope/",
    kind: "write",
    reason: "forwards an error report to the configured project",
  },
  {
    route: "POST /api/voice/speak",
    kind: "write",
    reason: "speaks the text the caller sends",
  },
  {
    route: "POST /api/voice/transcribe",
    kind: "write",
    reason: "transcribes the audio the caller sends",
  },
  {
    route: "GET /.well-known/apple-app-site-association",
    kind: "public",
    reason: "from configuration",
  },
  { route: "GET /.well-known/assetlinks.json", kind: "public", reason: "from configuration" },
  {
    route: "GET /.well-known/oauth-protected-resource/api/v1/dozo/mcp",
    kind: "public",
    reason: "the MCP endpoint's metadata, a constant",
  },
  { route: "GET /api/auth/capabilities", kind: "public", reason: "sign-in options" },
  { route: "GET /api/monitoring/config", kind: "public", reason: "where error reports go" },
  { route: "GET /api/v1/assets/mermaid.js", kind: "public", reason: "a constant script" },
  { route: "GET /api/v1/assets/page-runtime.js", kind: "public", reason: "a constant script" },
  {
    route: "GET /api/v1/integration-claims",
    kind: "public",
    reason: "approved claims for the marketing site",
  },
  {
    route: "GET /api/dozo/catalog-images/:file",
    kind: "public",
    reason: "the plugin catalog's own pictures",
  },
  {
    route: "GET /api/devices/connect",
    kind: "public",
    reason: "only says to upgrade; the socket is upgraded before the app",
  },
  { route: "GET /health", kind: "public", reason: "a constant body" },
  { route: "GET /ready", kind: "public", reason: "readiness" },
  { route: "GET /internal/health", kind: "public", reason: "liveness for operators" },
  {
    route: "ALL /api/desktop-settings/rpc/*",
    kind: "not-served",
    reason: "the desktop app's local settings; the server answers 403 to everyone",
  },
];

/** The auth endpoints of AUTH_ENDPOINTS, classified the same way. */
export const AUTH_ENDPOINT_DATA: readonly RouteData[] = [
  {
    route: "GET /api/auth/get-session",
    kind: "own-account",
    owner: "session",
    reason: "the caller's session",
  },
  {
    route: "GET /api/auth/list-sessions",
    kind: "own-account",
    owner: "session",
    reason: "the caller's sessions",
  },
  {
    route: "GET /api/auth/list-accounts",
    kind: "own-account",
    owner: "session",
    reason: "the caller's sign-in methods",
  },
  {
    route: "GET /api/auth/account-info",
    kind: "not-served",
    reason: "details of a social sign-in only; a password account has none (400 for the owner)",
  },
  {
    route: "GET /api/auth/account-security",
    kind: "nameless",
    reason: "the caller's own sign-in flags",
  },
  {
    route: "GET /api/auth/passkey/list-user-passkeys",
    kind: "nameless",
    reason: "the caller's passkeys; the world's people have none",
  },
  {
    route: "GET /api/auth/organization/list",
    kind: "not-served",
    reason: "the auth library's organization endpoints are switched off",
  },
  {
    route: "GET /api/auth/organization/get-full-organization",
    kind: "not-served",
    reason: "the auth library's organization endpoints are switched off",
  },
  {
    route: "GET /api/auth/organization/list-members",
    kind: "not-served",
    reason: "the auth library's organization endpoints are switched off",
  },
  {
    route: "GET /api/auth/organization/get-active-member",
    kind: "not-served",
    reason: "the auth library's organization endpoints are switched off",
  },
  {
    route: "GET /api/auth/dozo/email-link",
    kind: "nameless",
    reason: "whether a signed link verified, with no address for a link the caller did not open",
  },
  {
    route: "GET /api/auth/dozo/hosted-login/keys",
    kind: "not-served",
    reason: "hosted sign-in is off in a local install",
  },
  {
    route: "POST /api/auth/organization/set-active",
    kind: "write",
    reason: "switches the caller's active organization",
  },
  {
    route: "POST /api/auth/organization/remove-member",
    kind: "write",
    reason: "removes a member; the owner's call would remove A",
  },
  { route: "POST /api/auth/unlink-account", kind: "write", reason: "unlinks a sign-in method" },
  { route: "POST /api/auth/revoke-session", kind: "write", reason: "ends one session" },
  { route: "POST /api/auth/passkey/delete-passkey", kind: "write", reason: "deletes a passkey" },
  {
    route: "POST /api/auth/request-identity-code",
    kind: "write",
    reason: "mails the caller a code",
  },
];
