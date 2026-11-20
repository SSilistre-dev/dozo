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
import { deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  DOZO_PLAN_GRANT_SELECT,
  IsolationError,
  ownedOrganizationId,
  paidTierOf,
  runAsSystem,
  tierInForce,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

/**
 * Sign-in to a local server with an account kept on the hosted server.
 *
 * The hosted server (`HOSTED_LOGIN_SIGNING_KEY` set) hands its signed-in user a short-lived login
 * token signed with Ed25519 and publishes the public key. A local server (`HOSTED_LOGIN_ISSUER`
 * set to the hosted server's origin) asks for one, checks it and signs its own user in: the
 * local account is found by the hosted account's id, so a changed address keeps the same user,
 * and password and email-code sign-in are closed there. With neither set nothing changes.
 *
 * The flow, each step a top-level navigation in the same browser:
 * 1. local `GET /api/auth/dozo/hosted-login/start`: a single-use nonce, kept in the local database
 *    and in a cookie, goes to the hosted server as the token's audience;
 * 2. hosted `GET /api/auth/dozo/hosted-login/issue?audience=<nonce>&return=<local callback>`:
 *    the signed-in user's token, back to the loopback callback only;
 * 3. local `GET /api/auth/dozo/hosted-login/callback?token=<token>`: checks signature, issuer,
 *    times and that the audience is this browser's unused nonce, then opens the session.
 * The keys: hosted `GET /api/auth/dozo/hosted-login/keys`.
 */

export const HOSTED_LOGIN_PATH = "/dozo/hosted-login";
export const TOKEN_TYPE = "dozo-local-login+jwt";
/** The longest a token may live. */
export const TOKEN_LIFETIME_SECONDS = 60;
/** How far the local clock may be from the hosted one. The nonce bounds replay on its own. */
export const CLOCK_LEEWAY_SECONDS = 60;
/** How long a started sign-in may take, on the local clock. */
export const NONCE_LIFETIME_SECONDS = 5 * 60;
/** The local server asks the hosted one for keys at most this often. */
export const KEY_REFRESH_SECONDS = 60;
/** The account provider id a hosted account is linked under on the local server. */
export const HOSTED_PROVIDER_ID = "dozo-hosted";

const NONCE_COOKIE = "dozo_hosted_login";
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_LENGTH = 4096;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PASSWORD_PATHS = new Set([
  "/sign-in/email",
  "/sign-up/email",
  "/request-password-reset",
  "/reset-password",
  "/email-otp/send-verification-otp",
  "/sign-in/email-otp",
  "/forget-password/email-otp",
]);

export type HostedLoginConfig =
  | { mode: "issuer"; signingKey: KeyObject }
  | { mode: "verifier"; issuer: string }
  | null;

/** Reads the mode from the environment; a value that cannot work stops the server at start. */
export function hostedLoginConfig(source: NodeJS.ProcessEnv = process.env): HostedLoginConfig {
  const key = source.HOSTED_LOGIN_SIGNING_KEY?.trim();
  const issuer = source.HOSTED_LOGIN_ISSUER?.trim();
  if (key && issuer)
    throw new Error("Set HOSTED_LOGIN_SIGNING_KEY or HOSTED_LOGIN_ISSUER, not both");
  if (key) return { mode: "issuer", signingKey: signingKeyFrom(key) };
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
    throw new Error("HOSTED_LOGIN_SIGNING_KEY must be an Ed25519 private key");
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

/** Where the hosted server may send a token: this path on a loopback address, any port. */
export function loopbackCallback(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const ok =
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
  plan: string;
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
    !text(claims.plan, 64) ||
    !text(claims.jti, 64)
  )
    throw new HostedLoginError("claims");
  return claims as HostedLoginClaims;
}

/**
 * The hosted server's public keys, fetched from it over its own origin and kept in memory. A key
 * id not seen yet fetches them again, at most once a `KEY_REFRESH_SECONDS`, so a new key is
 * picked up on its first token and a flood of unknown ids costs one request a minute. Only
 * Ed25519 keys whose id matches their key are kept.
 */
export function issuerKeys(issuer: string, fetcher: typeof fetch = fetch) {
  let keys = new Map<string, KeyObject>();
  let fetchedAt = Number.NEGATIVE_INFINITY;
  const refresh = async () => {
    const response = await fetcher(`${issuer}/api/auth${HOSTED_LOGIN_PATH}/keys`, {
      redirect: "error",
      signal: deadlineSignal(5000),
    });
    if (!response.ok) throw new Error(`Hosted login keys: HTTP ${response.status}`);
    const body = (await response.json()) as { keys?: unknown };
    const next = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
      const { kty, crv, x, kid } = (jwk ?? {}) as Record<string, unknown>;
      if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || kid !== keyId(x)) continue;
      next.set(kid, createPublicKey({ key: { kty, crv, x }, format: "jwk" }));
    }
    keys = next;
  };
  return async (kid: string, now = Date.now()): Promise<KeyObject | null> => {
    if (!keys.has(kid) && now - fetchedAt >= KEY_REFRESH_SECONDS * 1000) {
      fetchedAt = now;
      await refresh();
    }
    return keys.get(kid) ?? null;
  };
}

type PlanReader = Pick<PrismaClient, "member" | "organization">;

/** The tier id of the plan in force on the user's own organization; Free without one. */
export async function hostedPlanOf(prisma: PlanReader, userId: string): Promise<string> {
  return runAsSystem("hosted login plan", async () => {
    let organizationId: string;
    try {
      organizationId = await ownedOrganizationId(prisma, userId);
    } catch (error) {
      if (error instanceof IsolationError) return "standard";
      throw error;
    }
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        billing: { select: { status: true, byokTier: true } },
        dozoPlanGrant: { select: DOZO_PLAN_GRANT_SELECT },
      },
    });
    return (
      tierInForce(paidTierOf(organization?.billing), organization?.dozoPlanGrant) ?? "standard"
    );
  });
}

const nonceIdentifier = (nonce: string) =>
  `dozo-hosted-login:${createHash("sha256").update(nonce).digest("hex")}`;

export type HostedLoginDeps = {
  webOrigin: string;
  planOf: (userId: string) => Promise<string>;
  config?: HostedLoginConfig;
  fetcher?: typeof fetch;
};

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/** The plugins for this server's mode: none when it has no mode. */
export function dozoHostedLogin(deps: HostedLoginDeps): BetterAuthPlugin[] {
  const config = deps.config === undefined ? hostedLoginConfig() : deps.config;
  if (!config) return [];
  const rateLimit = [
    {
      pathMatcher: (path: string) => path.startsWith(`${HOSTED_LOGIN_PATH}/`),
      window: 60,
      max: 10,
    },
  ];
  if (config.mode === "issuer") return [issuerPlugin(config.signingKey, deps, rateLimit)];
  return [verifierPlugin(config.issuer, deps, rateLimit)];
}

type RateLimit = NonNullable<BetterAuthPlugin["rateLimit"]>;

function issuerPlugin(
  signingKey: KeyObject,
  deps: HostedLoginDeps,
  rateLimit: RateLimit,
): BetterAuthPlugin {
  const jwk = publicJwk(signingKey);
  return {
    id: "dozo-hosted-login-issuer",
    rateLimit,
    endpoints: {
      dozoHostedLoginKeys: createAuthEndpoint(
        `${HOSTED_LOGIN_PATH}/keys`,
        { method: "GET" },
        async (ctx) => {
          ctx.setHeader("Cache-Control", "public, max-age=300");
          return ctx.json({ keys: [jwk] });
        },
      ),
      dozoHostedLoginIssue: createAuthEndpoint(
        `${HOSTED_LOGIN_PATH}/issue`,
        { method: "GET" },
        async (ctx) => {
          const audience = typeof ctx.query?.audience === "string" ? ctx.query.audience : "";
          const back = loopbackCallback(
            typeof ctx.query?.return === "string" ? ctx.query.return : "",
          );
          // Never redirect anywhere a request names unless it is the loopback callback.
          if (!NONCE.test(audience) || !back) throw new APIError("BAD_REQUEST");
          const session = await getSessionFromCtx(ctx);
          if (!session) throw ctx.redirect(new URL("/sign-in", deps.webOrigin).href);
          const { user } = session;
          back.searchParams.set(
            "token",
            signLoginToken(signingKey, {
              iss: new URL(ctx.context.baseURL).origin,
              sub: user.id,
              aud: audience,
              email: user.email,
              email_verified: user.emailVerified === true,
              name: user.name ?? "",
              plan: await deps.planOf(user.id),
            }),
          );
          for (const [name, value] of Object.entries(noStore)) ctx.setHeader(name, value);
          throw ctx.redirect(back.href);
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
  const failed = new URL("/sign-in?error=hosted_login_failed", deps.webOrigin).href;
  return {
    id: "dozo-hosted-login",
    rateLimit,
    hooks: {
      before: [
        {
          // The account lives on the hosted server: no local password or emailed code.
          matcher: (ctx) => PASSWORD_PATHS.has(ctx.path ?? ""),
          handler: async () => {
            throw new APIError("NOT_FOUND");
          },
        },
      ],
    },
    endpoints: {
      dozoHostedLoginStart: createAuthEndpoint(
        `${HOSTED_LOGIN_PATH}/start`,
        { method: "GET" },
        async (ctx) => {
          const nonce = randomBytes(32).toString("base64url");
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: nonceIdentifier(nonce),
            value: "1",
            expiresAt: new Date(Date.now() + NONCE_LIFETIME_SECONDS * 1000),
          });
          const cookie = ctx.context.createAuthCookie(NONCE_COOKIE, {
            maxAge: NONCE_LIFETIME_SECONDS,
          });
          await ctx.setSignedCookie(cookie.name, nonce, ctx.context.secret, cookie.attributes);
          const issue = new URL(`/api/auth${HOSTED_LOGIN_PATH}/issue`, issuer);
          issue.searchParams.set("audience", nonce);
          issue.searchParams.set("return", `${ctx.context.baseURL}${HOSTED_LOGIN_PATH}/callback`);
          throw ctx.redirect(issue.href);
        },
      ),
      dozoHostedLoginCallback: createAuthEndpoint(
        `${HOSTED_LOGIN_PATH}/callback`,
        { method: "GET" },
        async (ctx) => {
          for (const [name, value] of Object.entries(noStore)) ctx.setHeader(name, value);
          const cookie = ctx.context.createAuthCookie(NONCE_COOKIE);
          const nonce = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
          ctx.setCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });
          const token = typeof ctx.query?.token === "string" ? ctx.query.token : "";
          if (!nonce || !NONCE.test(nonce) || !token) throw ctx.redirect(failed);
          let claims: HostedLoginClaims;
          try {
            claims = await verifyLoginToken(token, { issuer, audience: nonce, keyFor });
          } catch (error) {
            ctx.context.logger.warn(
              error instanceof HostedLoginError ? error.message : "Hosted login keys unavailable",
            );
            throw ctx.redirect(failed);
          }
          // Single use, across instances: only the request that deletes the row goes on.
          const used = await ctx.context.adapter.deleteMany({
            model: "verification",
            where: [
              { field: "identifier", value: nonceIdentifier(nonce) },
              { field: "expiresAt", operator: "gt", value: new Date() },
            ],
          });
          if (used !== 1) throw ctx.redirect(failed);
          const signedIn = await signInHostedUser(ctx, claims);
          if (!signedIn) throw ctx.redirect(failed);
          throw ctx.redirect(new URL("/", deps.webOrigin).href);
        },
      ),
    },
  };
}

/**
 * Finds the local user linked to the hosted account, or creates it, and opens a session. The
 * install keeps the first hosted account that signs in and refuses any other, and the session
 * hook still decides admission (a user created for a refused sign-in is removed again). A local
 * account that only shares the address is never taken over.
 */
async function signInHostedUser(ctx: GenericEndpointContext, claims: HostedLoginClaims) {
  const adapter = ctx.context.internalAdapter;
  const email = claims.email.toLowerCase();
  const owner = await adapter.findAccountOwnerByKey({
    providerId: HOSTED_PROVIDER_ID,
    accountId: claims.sub,
  });
  let user = owner?.kind === "owned" ? owner.user : null;
  const created = !user;
  if (user) {
    if (user.email !== email || user.name !== claims.name) {
      const taken = user.email !== email && Boolean(await adapter.findUserByEmail(email));
      user = await adapter.updateUser(user.id, {
        ...(taken ? {} : { email, emailVerified: claims.email_verified }),
        name: claims.name,
      });
    }
  } else {
    // One install, one hosted account: the first to sign in keeps it.
    const hostedAccounts = await ctx.context.adapter.count({
      model: "account",
      where: [{ field: "providerId", value: HOSTED_PROVIDER_ID }],
    });
    if (hostedAccounts > 0 || (await adapter.findUserByEmail(email))) return false;
    user = await adapter.createUser(
      { email, name: claims.name, emailVerified: claims.email_verified },
      { method: "oauth", oauth: { providerId: HOSTED_PROVIDER_ID } },
    );
    await adapter.linkAccount({
      userId: user.id,
      providerId: HOSTED_PROVIDER_ID,
      accountId: claims.sub,
    });
  }
  try {
    const session = await adapter.createSession(user.id);
    await setSessionCookie(ctx, { session, user });
    return true;
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    if (created) await bestEffort("remove refused hosted user", adapter.deleteUser(user.id));
    return false;
  }
}
