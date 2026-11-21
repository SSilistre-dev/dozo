import type { KeyObject } from "node:crypto";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { deadlineSignal, MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { BetterAuthPlugin, GenericEndpointContext, User } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { RELAY_SESSION_USER_AGENT } from "./dozo-relay-session.js";

/**
 * Sign-in to a local server with an account kept on the hosted server.
 *
 * The hosted server (`HOSTED_LOGIN_SIGNING_KEY` set) hands its signed-in user, once they agree, a
 * short-lived login token signed with Ed25519 and publishes the public key. A local server
 * (`HOSTED_LOGIN_ISSUER` set to the hosted server's origin) asks for one, checks it and signs its
 * own user in: the local account is found by the hosted account's id, so a changed address keeps
 * the same user, and every other way to sign in or to add a credential is closed there. With
 * neither variable set nothing changes.
 *
 * A local server that already has users of its own never refuses to start: until each is linked
 * it keeps password and passkey sign-in, makes no new account and offers no hosted sign-in
 * ("legacy" mode). A signed-in user links their account from the settings with the same flow
 * (`start` with `link`, proven by their own session, never a paired phone's); the password and
 * passkeys go with it, and once no
 * such user is left the server is in hosted mode. Each existing user links their own hosted
 * account; once any is linked, a hosted account that is not linked is refused, as a new account
 * would be. A user marked for it (`ADOPT_PREFIX`) is linked by the next hosted sign-in. Sessions
 * there last `LOCAL_SESSION_DAYS`, so a computer left offline keeps its user.
 *
 * The flow, in one browser:
 * 1. local `POST /api/auth/dozo/hosted-login/start`, from the local sign-in page only (its own
 *    origin): a single-use nonce, kept in the local database and in a cookie, and the hosted web
 *    page to open, `/dozo/hosted-login?audience=<nonce>&return=<url>` (which signs the user in
 *    first when needed, and asks them to agree);
 * 2. hosted `POST /api/auth/dozo/hosted-login/issue` from that page, with the session and the
 *    page's own origin: the token, inside the loopback callback address it may go to;
 * 3. local `GET /api/auth/dozo/hosted-login/callback?token=<token>`: checks signature, issuer,
 *    times and that the audience is this browser's unused nonce, then opens the session.
 * The keys: hosted `GET /api/auth/dozo/hosted-login/keys`.
 *
 * `HOSTED_LOGIN_ISSUER` is the hosted web origin, the one place the local server knows it by: the
 * page opens there, the keys are read there (the web server answers `/api` as the stack's does),
 * and the hosted server signs its web origin as the token's issuer.
 */

export const HOSTED_LOGIN_PATH = "/dozo/hosted-login";
/** The hosted web page that asks the user to agree (`apps/web/src/pages/dozo-hosted-login.tsx`). */
export const HOSTED_LOGIN_PAGE = "/dozo/hosted-login";
export const TOKEN_TYPE = "dozo-local-login+jwt";
/** The longest a token may live. */
export const TOKEN_LIFETIME_SECONDS = 60;
/** How far the local clock may be from the hosted one. The nonce bounds replay on its own. */
export const CLOCK_LEEWAY_SECONDS = 60;
/** How long a started sign-in may take, on the local clock. */
export const NONCE_LIFETIME_SECONDS = 5 * 60;
/**
 * After keys were read, an unknown key id reads them again only this much later. Short, so a key
 * swapped in right after a read is picked up on the next try; a flood of made-up key ids still
 * costs the hosted server one request in this time per computer.
 */
export const KEY_REFRESH_SECONDS = 10;
/** After reading the keys failed, the next try waits this long. */
export const KEY_RETRY_SECONDS = 5;
/** The largest key list the local server reads. */
export const MAX_KEYS_BYTES = 64 * 1024;
/** The account provider id a hosted account is linked under on the local server. */
export const HOSTED_PROVIDER_ID = "dozo-hosted";
/** How long a session on a local server lasts, renewed by use (the library's default is a week). */
export const LOCAL_SESSION_DAYS = 90;
const LOCAL_SESSION_SECONDS = LOCAL_SESSION_DAYS * 24 * 60 * 60;
/** Where a refused sign-in comes back, with why when the person can act on it. */
export const SIGN_IN_ERRORS = {
  failed: "hosted_login_failed",
  clock: "hosted_login_clock",
} as const;

const NONCE_COOKIE = "dozo_hosted_login";
const NONCE_PREFIX = "dozo-hosted-login:";
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_LENGTH = 4096;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * What a local server closes: every other way to sign in, to create an account, or to add or
 * change a credential or the address, since the account lives on the hosted server.
 */
const CLOSED_PREFIXES = [
  "/reset-password",
  "/sign-in/",
  "/sign-up/",
  "/passkey/",
  "/email-otp/",
  "/forget-password",
  "/callback/",
  "/oauth2/",
];
const CLOSED_PATHS = new Set([
  "/request-password-reset",
  "/change-password",
  "/set-password",
  "/change-email",
  "/link-social",
  "/send-verification-email",
  "/verify-email",
]);

/**
 * What stays open while the server is in legacy mode: signing in with a password or a passkey,
 * and the owner's own password upkeep. Making new accounts and every other way in stay closed.
 */
export function openInLegacyMode(path: string): boolean {
  return (
    path === "/sign-in/email" ||
    path === "/request-password-reset" ||
    path === "/change-password" ||
    path.startsWith("/reset-password") ||
    path.startsWith("/passkey/")
  );
}

export function closedOnLocalServer(path: string): boolean {
  return CLOSED_PATHS.has(path) || CLOSED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export type HostedLoginConfig =
  | { mode: "issuer"; signingKey: KeyObject; overlapKey?: KeyObject }
  | { mode: "verifier"; issuer: string }
  | null;

/** Reads the mode from the environment; a value that cannot work stops the server at start. */
export function hostedLoginConfig(source: NodeJS.ProcessEnv = process.env): HostedLoginConfig {
  const key = source.HOSTED_LOGIN_SIGNING_KEY?.trim();
  const issuer = source.HOSTED_LOGIN_ISSUER?.trim();
  if (key && issuer)
    throw new Error("Set HOSTED_LOGIN_SIGNING_KEY or HOSTED_LOGIN_ISSUER, not both");
  const overlap = source.HOSTED_LOGIN_OVERLAP_KEY?.trim();
  if (key)
    return {
      mode: "issuer",
      signingKey: signingKeyFrom(key),
      ...(overlap ? { overlapKey: signingKeyFrom(overlap) } : {}),
    };
  if (issuer) return { mode: "verifier", issuer: issuerOrigin(issuer) };
  return null;
}

/** An Ed25519 private key as PKCS#8 PEM (newlines may be written `\n`) or base64 DER. */
export function signingKeyFrom(value: string): KeyObject {
  const pem = value.replaceAll("\\n", "\n");
  const key = pem.includes("-----BEGIN")
    ? createPrivateKey(pem)
    : createPrivateKey({ key: Buffer.from(value, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("HOSTED_LOGIN_SIGNING_KEY and HOSTED_LOGIN_OVERLAP_KEY must be Ed25519 keys");
  return key;
}

/** The hosted server's origin: https, or http on a loopback address for development. */
export function issuerOrigin(value: string): string {
  const url = new URL(value);
  const local = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.origin !== value.replace(/\/$/, ""))
    throw new Error("HOSTED_LOGIN_ISSUER must be an https origin, without a path");
  return url.origin;
}

/**
 * Where the hosted server may send a token: the callback path on a loopback address, any port,
 * written exactly as a URL prints it, so no other spelling of a host or path gets through.
 */
export function loopbackCallback(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const ok =
    url.href === value &&
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === `/api/auth${HOSTED_LOGIN_PATH}/callback`;
  return ok ? url : null;
}

const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export type PublicJwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
};

/** The key id: the SHA-256 of the raw public key, so a key always has the same one. */
function keyId(x: string): string {
  return b64(createHash("sha256").update(Buffer.from(x, "base64url")).digest());
}

export function publicJwk(signingKey: KeyObject): PublicJwk {
  const x = String(createPublicKey(signingKey).export({ format: "jwk" }).x);
  return { kty: "OKP", crv: "Ed25519", x, kid: keyId(x), alg: "EdDSA", use: "sig" };
}

export type HostedLoginClaims = {
  v: 1;
  iss: string;
  sub: string;
  aud: string;
  email: string;
  email_verified: boolean;
  name: string;
  iat: number;
  exp: number;
  jti: string;
};

export function signLoginToken(
  signingKey: KeyObject,
  claims: Omit<HostedLoginClaims, "v" | "iat" | "exp" | "jti">,
  now = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  const header = { alg: "EdDSA", typ: TOKEN_TYPE, kid: publicJwk(signingKey).kid };
  const payload: HostedLoginClaims = {
    v: 1,
    ...claims,
    iat,
    exp: iat + TOKEN_LIFETIME_SECONDS,
    jti: randomUUID(),
  };
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${b64(sign(null, Buffer.from(input), signingKey))}`;
}

/** Why a token was refused; the callback answers every one the same way. */
export class HostedLoginError extends Error {
  constructor(readonly reason: string) {
    super(`Hosted login refused: ${reason}`);
    this.name = "HostedLoginError";
  }
}

function json(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString());
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {}
  throw new HostedLoginError("malformed");
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const seconds = (value: unknown): value is number => Number.isSafeInteger(value);

/**
 * The claims of a token this issuer signed for `audience`, or a `HostedLoginError`. Only EdDSA
 * with a key the issuer publishes is accepted, whatever the header asks for.
 */
export async function verifyLoginToken(
  token: string,
  expected: {
    issuer: string;
    audience: string;
    keyFor: (kid: string) => Promise<KeyObject | null>;
  },
  now = Date.now(),
): Promise<HostedLoginClaims> {
  const parts = token.split(".");
  if (token.length > MAX_TOKEN_LENGTH || parts.length !== 3)
    throw new HostedLoginError("malformed");
  const [header = "", payload = "", signature = ""] = parts;
  const head = json(header);
  if (head.alg !== "EdDSA" || head.typ !== TOKEN_TYPE || typeof head.kid !== "string")
    throw new HostedLoginError("header");
  const key = await expected.keyFor(head.kid);
  if (!key) throw new HostedLoginError("unknown key");
  const sig = Buffer.from(signature, "base64url");
  if (sig.length !== 64 || !verify(null, Buffer.from(`${header}.${payload}`), key, sig))
    throw new HostedLoginError("signature");
  const claims = json(payload);
  if (claims.v !== 1) throw new HostedLoginError("version");
  if (claims.iss !== expected.issuer) throw new HostedLoginError("issuer");
  if (claims.aud !== expected.audience) throw new HostedLoginError("audience");
  const { iat, exp } = claims;
  if (!seconds(iat) || !seconds(exp) || exp <= iat || exp - iat > TOKEN_LIFETIME_SECONDS)
    throw new HostedLoginError("lifetime");
  const at = Math.floor(now / 1000);
  if (iat > at + CLOCK_LEEWAY_SECONDS || exp < at - CLOCK_LEEWAY_SECONDS)
    throw new HostedLoginError("expired");
  if (
    !text(claims.sub, 255) ||
    !text(claims.email, 320) ||
    !String(claims.email).includes("@") ||
    typeof claims.name !== "string" ||
    typeof claims.email_verified !== "boolean" ||
    !text(claims.jti, 64)
  )
    throw new HostedLoginError("claims");
  return claims as HostedLoginClaims;
}

/**
 * The hosted server's public keys, fetched from it over its own origin and kept in memory. A key
 * id not seen yet reads them again, at most once a `KEY_REFRESH_SECONDS` after a read and once a
 * `KEY_RETRY_SECONDS` after a failure, with one request shared by everyone waiting, so a new key
 * is picked up on its first token and a flood of unknown ids costs one request that often. Only
 * Ed25519 keys whose id matches their key are kept.
 */
export function issuerKeys(issuer: string, fetcher?: typeof fetch) {
  let keys = new Map<string, KeyObject>();
  let nextReadAt = 0;
  let reading: Promise<void> | null = null;
  const read = async () => {
    const response = await (fetcher ?? fetch)(`${issuer}/api/auth${HOSTED_LOGIN_PATH}/keys`, {
      redirect: "error",
      signal: deadlineSignal(5000),
    });
    if (!response.ok) throw new Error(`Hosted login keys: HTTP ${response.status}`);
    const raw = await response.text();
    if (raw.length > MAX_KEYS_BYTES) throw new Error("Hosted login keys: answer too large");
    const body = JSON.parse(raw) as { keys?: unknown };
    const next = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
      const { kty, crv, x, kid } = (jwk ?? {}) as Record<string, unknown>;
      if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || kid !== keyId(x)) continue;
      next.set(kid, createPublicKey({ key: { kty, crv, x }, format: "jwk" }));
    }
    keys = next;
  };
  return async (kid: string, now = Date.now()): Promise<KeyObject | null> => {
    if (!keys.has(kid) && !reading && now >= nextReadAt) {
      reading = read()
        .then(
          () => {
            nextReadAt = now + KEY_REFRESH_SECONDS * 1000;
          },
          (error: unknown) => {
            nextReadAt = now + KEY_RETRY_SECONDS * 1000;
            throw error;
          },
        )
        .finally(() => {
          reading = null;
        });
    }
    if (!keys.has(kid) && reading) await reading;
    return keys.get(kid) ?? null;
  };
}

const nonceIdentifier = (nonce: string) =>
  `${NONCE_PREFIX}${createHash("sha256").update(nonce).digest("hex")}`;

type HostedLoginPrisma = Pick<PrismaClient, "$transaction" | "user" | "verification">;
type Locked = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * Runs `work` alone across every process of the local server: a Postgres advisory lock held by a
 * transaction, as the single-account admission does, so two first sign-ins cannot both create
 * an account. It is only a lock: `work` writes over other connections, outside this transaction,
 * and is a few short queries, well inside the timeout.
 */
export function installLock(prisma: Pick<PrismaClient, "$transaction">): Locked {
  return (work) =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dozo:hosted-login'))`;
        return work();
      },
      { timeout: 30_000 },
    );
}

type ModePrisma = Pick<PrismaClient, "user" | "verification">;

/**
 * Marks a user the next hosted sign-in links, whichever hosted account it is (`user:<id>`, left by
 * `dozo-unlink-hosted`), or the user made for an address whose first sign-in may not have reached
 * its link (`email:<address>`, written before that user is made). Nothing else makes a user
 * adoptable, so a user the server made any other way is never handed to a hosted account.
 */
export const ADOPT_PREFIX = "dozo-hosted-adopt:";
const adoptUser = (id: string) => `${ADOPT_PREFIX}user:${id}`;
const adoptEmail = (email: string) => `${ADOPT_PREFIX}email:${email}`;

type Unlinked = { id: string; email: string; adopt: "user" | "email" | null };

/** The users not linked to a hosted account, each with whether a hosted sign-in may link it. */
async function unlinkedUsers(prisma: ModePrisma): Promise<Unlinked[]> {
  const [users, marks] = await Promise.all([
    prisma.user.findMany({
      where: {
        accounts: { none: { providerId: HOSTED_PROVIDER_ID } },
        NOT: { email: { endsWith: MESSAGING_EMAIL_SUFFIX } },
      },
      select: { id: true, email: true, accounts: { select: { id: true }, take: 1 } },
      take: 50,
    }),
    prisma.verification.findMany({
      where: { identifier: { startsWith: ADOPT_PREFIX } },
      select: { identifier: true },
    }),
  ]);
  const marked = new Set(marks.map((mark) => mark.identifier));
  return users.map((user) => ({
    id: user.id,
    email: user.email,
    adopt: marked.has(adoptUser(user.id))
      ? "user"
      : // Only a user still without any account: one with a password is the owner's own.
        user.accounts.length === 0 && marked.has(adoptEmail(user.email))
        ? "email"
        : null,
  }));
}

/**
 * Whether a local server still has a user of its own, not linked to a hosted account and not
 * marked to be: it then keeps password and passkey sign-in and offers linking instead of hosted
 * sign-in ("legacy" mode).
 */
export async function legacyAccounts(prisma: ModePrisma): Promise<boolean> {
  return (await unlinkedUsers(prisma)).some((user) => user.adopt === null);
}

/**
 * The public capabilities for this server: `hostedLogin`, it signs in only with the hosted
 * account; `hostedLink`, it still has password accounts, which a signed-in user may link.
 */
export async function hostedLoginCapabilities(
  prisma: ModePrisma,
  config: HostedLoginConfig = hostedLoginConfig(),
): Promise<{ hostedLogin: boolean; hostedLink: boolean }> {
  if (config?.mode !== "verifier") return { hostedLogin: false, hostedLink: false };
  const legacy = await legacyAccounts(prisma);
  return { hostedLogin: !legacy, hostedLink: legacy };
}

export type HostedLoginDeps = {
  prisma: HostedLoginPrisma;
  webOrigin: string;
  config?: HostedLoginConfig;
  fetcher?: typeof fetch;
  lock?: Locked;
};

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/** The plugins for this server's mode: none when it has no mode. */
export function dozoHostedLogin(deps: HostedLoginDeps): BetterAuthPlugin[] {
  const config = deps.config === undefined ? hostedLoginConfig() : deps.config;
  if (!config) return [];
  // Each endpoint counts on its own (the library keys a count by address and path). The callback
  // allows more, since a page elsewhere can spend an address's count on it without a cookie.
  const per = (name: string, max: number) => ({
    pathMatcher: (path: string) => path === `${HOSTED_LOGIN_PATH}/${name}`,
    window: 60,
    max,
  });
  const rateLimit = [per("start", 10), per("issue", 10), per("keys", 10), per("callback", 60)];
  if (config.mode === "issuer") return [issuerPlugin(config, deps, rateLimit)];
  return [verifierPlugin(config.issuer, deps, rateLimit)];
}

type RateLimit = NonNullable<BetterAuthPlugin["rateLimit"]>;

function issuerPlugin(
  { signingKey, overlapKey }: { signingKey: KeyObject; overlapKey?: KeyObject },
  deps: HostedLoginDeps,
  rateLimit: RateLimit,
): BetterAuthPlugin {
  const keys = [signingKey, ...(overlapKey ? [overlapKey] : [])].map(publicJwk);
  const webOrigin = new URL(deps.webOrigin).origin;
  return {
    id: "dozo-hosted-login-issuer",
    rateLimit,
    endpoints: {
      dozoHostedLoginKeys: createAuthEndpoint(
        `${HOSTED_LOGIN_PATH}/keys`,
        { method: "GET" },
        async (ctx) => {
          // Short, so a key published ahead of a change reaches every cache well before it signs.
          ctx.setHeader("Cache-Control", "public, max-age=60");
          return ctx.json({ keys });
        },
      ),
      // Only the web app's own page, after the user agreed, with their session: a request from
      // anywhere else, or a page that only links here, gets nothing.
      dozoHostedLoginIssue: createAuthEndpoint(
        `${HOSTED_LOGIN_PATH}/issue`,
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          if (ctx.headers?.get("origin") !== webOrigin) throw new APIError("FORBIDDEN");
          const body = (ctx.body ?? {}) as { audience?: unknown; return?: unknown };
          const audience = typeof body.audience === "string" ? body.audience : "";
          const back = loopbackCallback(typeof body.return === "string" ? body.return : "");
          if (!NONCE.test(audience) || !back) throw new APIError("BAD_REQUEST");
          const { user } = ctx.context.session;
          back.searchParams.set(
            "token",
            signLoginToken(signingKey, {
              iss: webOrigin,
              sub: user.id,
              aud: audience,
              email: user.email,
              email_verified: user.emailVerified === true,
              name: user.name ?? "",
            }),
          );
          for (const [name, value] of Object.entries(noStore)) ctx.setHeader(name, value);
          return ctx.json({ url: back.href });
        },
      ),
    },
  };
}

function verifierPlugin(
  issuer: string,
  deps: HostedLoginDeps,
  rateLimit: RateLimit,
): BetterAuthPlugin {
  const keyFor = issuerKeys(issuer, deps.fetcher);
  const lock = deps.lock ?? installLock(deps.prisma);
  const webOrigin = new URL(deps.webOrigin).origin;
  const back = (error?: keyof typeof SIGN_IN_ERRORS) =>
    new URL(error ? `/sign-in?error=${SIGN_IN_ERRORS[error]}` : "/", webOrigin).href;
  return {
    id: "dozo-hosted-login",
    rateLimit,
    // New sessions (the options the library's adapter reads) and their renewal and cookie (the
    // context's session settings) both take the local lifetime.
    init: (context) => ({
      options: { session: { expiresIn: LOCAL_SESSION_SECONDS } },
      context: { sessionConfig: { ...context.sessionConfig, expiresIn: LOCAL_SESSION_SECONDS } },
    }),
    hooks: {
      before: [
        {
          // Closed, but for password and passkey sign-in while legacy accounts are left.
          matcher: (ctx) => closedOnLocalServer(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            if (openInLegacyMode(ctx.path ?? "") && (await legacyAccounts(deps.prisma))) return;
            throw new APIError("NOT_FOUND");
          }),
        },
      ],
    },
    endpoints: {
      // Only the local page's own request: a page elsewhere cannot start one. `link` links the
      // signed-in user's own account instead of signing in, which is how a server with password
      // accounts moves to the hosted account; plain sign-in waits until none is left.
      dozoHostedLoginStart: createAuthEndpoint(
        `${HOSTED_LOGIN_PATH}/start`,
        { method: "POST" },
        async (ctx) => {
          if (ctx.headers?.get("origin") !== webOrigin) throw new APIError("FORBIDDEN");
          const link = (ctx.body as { link?: unknown } | undefined)?.link === true;
          let purpose = "1";
          if (link) {
            const session = await getSessionFromCtx(ctx);
            if (!session) throw new APIError("UNAUTHORIZED");
            // A paired phone's session may not change how the account signs in.
            if (fromPhone(session)) throw new APIError("FORBIDDEN");
            const accounts = await ctx.context.internalAdapter.findAccounts(session.user.id);
            if (accounts.some((account) => account.providerId === HOSTED_PROVIDER_ID))
              throw new APIError("CONFLICT");
            purpose = `link:${session.user.id}`;
          } else if (await legacyAccounts(deps.prisma)) {
            throw new APIError("FORBIDDEN");
          }
          const now = new Date();
          // Started sign-ins nobody finished go, so asking again and again keeps no rows.
          await ctx.context.adapter.deleteMany({
            model: "verification",
            where: [
              { field: "identifier", operator: "starts_with", value: NONCE_PREFIX },
              { field: "expiresAt", operator: "lt", value: now },
            ],
          });
          const nonce = randomBytes(32).toString("base64url");
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: nonceIdentifier(nonce),
            value: purpose,
            expiresAt: new Date(now.getTime() + NONCE_LIFETIME_SECONDS * 1000),
          });
          const cookie = ctx.context.createAuthCookie(NONCE_COOKIE, {
            maxAge: NONCE_LIFETIME_SECONDS,
          });
          await ctx.setSignedCookie(cookie.name, nonce, ctx.context.secret, cookie.attributes);
          const page = new URL(HOSTED_LOGIN_PAGE, issuer);
          page.searchParams.set("audience", nonce);
          page.searchParams.set("return", `${ctx.context.baseURL}${HOSTED_LOGIN_PATH}/callback`);
          return ctx.json({ url: page.href });
        },
      ),
      dozoHostedLoginCallback: createAuthEndpoint(
        `${HOSTED_LOGIN_PATH}/callback`,
        { method: "GET" },
        async (ctx) => {
          for (const [name, value] of Object.entries(noStore)) ctx.setHeader(name, value);
          const cookie = ctx.context.createAuthCookie(NONCE_COOKIE);
          const nonce = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
          const token = typeof ctx.query?.token === "string" ? ctx.query.token : "";
          if (!nonce || !NONCE.test(nonce) || !token) throw ctx.redirect(back("failed"));
          let claims: HostedLoginClaims;
          try {
            claims = await verifyLoginToken(token, { issuer, audience: nonce, keyFor });
          } catch (error) {
            ctx.context.logger.warn(
              error instanceof HostedLoginError ? error.message : "Hosted login keys unavailable",
            );
            // A token signed for this sign-in but out of time: the computer's clock is off.
            const clock = error instanceof HostedLoginError && error.reason === "expired";
            throw ctx.redirect(back(clock ? "clock" : "failed"));
          }
          // Only a token made for this browser's sign-in ends it; anything else leaves it waiting.
          ctx.setCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });
          const identifier = nonceIdentifier(nonce);
          const purpose = (await ctx.context.internalAdapter.findVerificationValue(identifier))
            ?.value;
          // Single use, across instances: only the request that deletes the row goes on.
          const used = await ctx.context.adapter.deleteMany({
            model: "verification",
            where: [
              { field: "identifier", value: identifier },
              { field: "expiresAt", operator: "gt", value: new Date() },
            ],
          });
          if (used !== 1 || !purpose) throw ctx.redirect(back("failed"));
          let done: boolean;
          try {
            done = purpose.startsWith("link:")
              ? await linkSignedInUser(ctx, claims, purpose.slice("link:".length), lock)
              : await signInHostedUser(ctx, claims, lock, deps.prisma);
          } catch (error) {
            // A refusal from the auth library: answered like any other, never as a raw error.
            if (!(error instanceof APIError)) throw error;
            done = false;
          }
          throw ctx.redirect(back(done ? undefined : "failed"));
        },
      ),
    },
  };
}

/**
 * Links the signed-in user's own account to the hosted account, as the start asked: the session
 * that finishes must be the one that started, and neither side may be linked already. Their
 * password goes, so once every account is linked the server signs in only with the hosted one.
 */
async function linkSignedInUser(
  ctx: GenericEndpointContext,
  claims: HostedLoginClaims,
  userId: string,
  lock: Locked,
): Promise<boolean> {
  const session = await getSessionFromCtx(ctx);
  if (!session || fromPhone(session) || session.user.id !== userId) return false;
  const adapter = ctx.context.internalAdapter;
  return lock(async () => {
    const owner = await adapter.findAccountOwnerByKey({
      providerId: HOSTED_PROVIDER_ID,
      accountId: claims.sub,
    });
    if (owner) return false;
    const accounts = await adapter.findAccounts(userId);
    if (accounts.some((account) => account.providerId === HOSTED_PROVIDER_ID)) return false;
    await adapter.linkAccount({ userId, providerId: HOSTED_PROVIDER_ID, accountId: claims.sub });
    // The password and the passkeys go: the account now signs in with the hosted one only.
    await ctx.context.adapter.deleteMany({
      model: "account",
      where: [
        { field: "userId", value: userId },
        { field: "providerId", value: "credential" },
      ],
    });
    if ("passkey" in ctx.context.tables)
      await ctx.context.adapter.deleteMany({
        model: "passkey",
        where: [{ field: "userId", value: userId }],
      });
    return true;
  });
}

/** A session a paired phone signed in with (`dozo-relay-session.ts`). */
const fromPhone = (session: { session: { userAgent?: string | null } }) =>
  session.session.userAgent === RELAY_SESSION_USER_AGENT;

/**
 * The local user the hosted account signs in as, under the install lock: the one linked to it;
 * else, while no hosted account is linked and no user of the server's own is left, a user marked
 * to be linked (`ADOPT_PREFIX`: one unlinked on the computer, whichever account signs in, or one
 * a first sign-in of this address left without its link); else a new user. The install keeps
 * the first hosted account that signs in and refuses any other.
 *
 * A new user and its link are two writes (the auth library's database adapter runs without
 * transactions here), so the address is marked first: a crash between them leaves a user the next
 * sign-in of that address links instead of refusing.
 */
async function hostedUser(
  ctx: GenericEndpointContext,
  claims: HostedLoginClaims,
  lock: Locked,
  prisma: HostedLoginPrisma,
): Promise<{ user: User; created: boolean } | null> {
  const adapter = ctx.context.internalAdapter;
  const email = claims.email.toLowerCase();
  return lock(async () => {
    const owner = await adapter.findAccountOwnerByKey({
      providerId: HOSTED_PROVIDER_ID,
      accountId: claims.sub,
    });
    if (owner?.kind === "owned")
      return { user: await refreshed(ctx, owner.user, claims), created: false };
    const hostedAccounts = await ctx.context.adapter.count({
      model: "account",
      where: [{ field: "providerId", value: HOSTED_PROVIDER_ID }],
    });
    if (hostedAccounts > 0) return null;
    // Read again under the lock: a legacy account keeps hosted sign-in closed.
    const unlinked = await unlinkedUsers(prisma);
    if (unlinked.some((user) => user.adopt === null)) return null;
    const adopt =
      unlinked.find((user) => user.adopt === "user") ??
      unlinked.find((user) => user.adopt === "email" && user.email === email);
    let user: User | null;
    if (adopt) {
      user = await adapter.findUserById(adopt.id);
    } else {
      if (await adapter.findUserByEmail(email)) return null;
      await adapter.createVerificationValue({
        identifier: adoptEmail(email),
        value: "1",
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      });
      user = await adapter.createUser(
        { email, name: claims.name, emailVerified: claims.email_verified },
        { method: "oauth", oauth: { providerId: HOSTED_PROVIDER_ID } },
      );
    }
    if (!user) return null;
    await adapter.linkAccount({
      userId: user.id,
      providerId: HOSTED_PROVIDER_ID,
      accountId: claims.sub,
    });
    for (const identifier of [adoptUser(user.id), adoptEmail(email)])
      await adapter.deleteVerificationByIdentifier(identifier);
    return { user: adopt ? await refreshed(ctx, user, claims) : user, created: !adopt };
  });
}

/** The user with the hosted account's current address and name, unless another user has it. */
async function refreshed(ctx: GenericEndpointContext, user: User, claims: HostedLoginClaims) {
  const email = claims.email.toLowerCase();
  if (user.email === email && user.name === claims.name) return user;
  const adapter = ctx.context.internalAdapter;
  const taken = user.email !== email && Boolean(await adapter.findUserByEmail(email));
  return adapter.updateUser(user.id, {
    ...(taken ? {} : { email, emailVerified: claims.email_verified }),
    name: claims.name,
  });
}

/**
 * Opens a session for the hosted account's local user. The session hook still decides admission;
 * a user created for a refused sign-in is removed again.
 */
async function signInHostedUser(
  ctx: GenericEndpointContext,
  claims: HostedLoginClaims,
  lock: Locked,
  prisma: HostedLoginPrisma,
): Promise<boolean> {
  const found = await hostedUser(ctx, claims, lock, prisma);
  if (!found) return false;
  const { user, created } = found;
  try {
    const session = await ctx.context.internalAdapter.createSession(user.id);
    await setSessionCookie(ctx, { session, user });
    return true;
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    if (created)
      await bestEffort(
        "remove refused hosted user",
        ctx.context.internalAdapter.deleteUser(user.id),
      );
    return false;
  }
}
