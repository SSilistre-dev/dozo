import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { bootstrapUserSpace } from "@rakazo/db";
import { expect, vi } from "vitest";
import { createAuth } from "./index.js";

/**
 * Better Auth's real routes over its offline memory adapter, with a fake mail provider and, on
 * request, a fake identity provider and Google, for the fork's sign-up verification tests. Each
 * test file mocks `better-auth/adapters/prisma` with the memory adapter and `@rakazo/db` as
 * `dozo-verify-email.test.ts` does; the provider fakes follow upstream's `oidc.test.ts`.
 */

export const SECRET = "offline-auth-secret-at-least-32-characters";
export const baseURL = "http://auth.example.test";
export const webOrigin = "http://web.example.test";
export const email = "ada@example.test";
export const password = "offline-password-1234";
export const otherPassword = "another-password-5678";
export const issuer = "https://identity.example.test";
const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_CLIENT = "offline-client";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };

/** An ID token signed with the providers' fake key. */
function idToken(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${part({ alg: "RS256", kid: "test-key" })}.${part({ iss: issuer, aud: "test-client", iat: now, exp: now + 300, ...claims })}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
}

/** What a provider says about the person: the victim's address, verified by the provider. */
export const providerClaims = (claims: Record<string, unknown> = {}) => ({
  sub: "provider-subject",
  email,
  email_verified: true,
  // Google vouches for an address only on its own domains or the hosted domain it names.
  hd: "example.test",
  name: "Provider user",
  ...claims,
});

const disposers: (() => void)[] = [];
/** Ends every fixture's identity provider discovery and fake network; for `afterEach`. */
export function disposeFixtures() {
  for (const dispose of disposers.splice(0)) dispose();
  vi.unstubAllGlobals();
}

export type FixtureOptions = {
  origin?: string;
  web?: string;
  allowlist?: string;
  signups?: string;
  /** A fake identity provider, offline, as upstream's `oidc.test.ts` fakes it. */
  oidc?: boolean;
  /** Google sign-in, its network replaced per test as upstream's `oidc.test.ts` does. */
  google?: boolean;
  singleAccount?: boolean;
};

export function fixture({
  origin = baseURL,
  web = webOrigin,
  allowlist = "",
  signups = "true",
  oidc = false,
  google = false,
  singleAccount = false,
}: FixtureOptions = {}) {
  const messages: TransactionalEmail[] = [];
  const devices = vi.fn(async () => ({ count: 0 }));
  const banned = new Set<string>();
  const mailCounts = new Map<string, number>();
  /** Accounts with a workspace; tracked only where a single-person deployment asks. */
  const members = singleAccount ? new Set<string>() : null;
  vi.mocked(bootstrapUserSpace).mockImplementation(async (_prisma, user) => {
    members?.add(user.id);
    return { spaceId: "space-1" } as never;
  });
  const authData = {
    user: [] as Record<string, unknown>[],
    account: [] as Record<string, unknown>[],
    session: [] as Record<string, unknown>[],
    verification: [] as Record<string, unknown>[],
    passkey: [] as Record<string, unknown>[],
  };
  const prisma = {
    authData,
    // The verification mail limit counts per address like the real one; the ban list reads `banned`.
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      if (sql.join("").includes("rateLimit")) {
        const key = String(values[1]);
        mailCounts.set(key, (mailCounts.get(key) ?? 0) + 1);
        return [{ count: mailCounts.get(key) }];
      }
      return (values[0] as string[]).filter((key) => banned.has(key)).map((value) => ({ value }));
    }),
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string | { in: string[] } } }) => {
        if (!members) return { spaceId: "space-1" };
        const ids = typeof where.userId === "string" ? [where.userId] : where.userId.in;
        const userId = ids.find((id) => members.has(id));
        return userId ? { spaceId: "space-1", userId } : null;
      }),
    },
    user: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async ({ where }: { where?: { id?: { not?: string } } } = {}) =>
        authData.user
          .filter((row) => row.id !== where?.id?.not)
          .map((row) => ({ id: String(row.id) })),
      ),
    },
    passkey: {
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const kept = authData.passkey.filter((row) => row.userId !== where.userId);
        const count = authData.passkey.length - kept.length;
        authData.passkey.splice(0, authData.passkey.length, ...kept);
        return { count };
      }),
    },
    account: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    messagingLinkCode: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    userDevice: { updateMany: devices },
    organization: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  };

  /** Authorization codes the fake identity provider issued, with what it signs for each. */
  const codes = new Map<string, { challenge: string; nonce: string; claims: object }>();
  // Only the identity provider's own URLs answer; any other request fails the test.
  const routes: Record<string, (init?: RequestInit) => Response> = {
    [`${issuer}/.well-known/openid-configuration`]: () =>
      Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      }),
    [`${issuer}/jwks`]: () => Response.json({ keys: [jwk] }),
    [`${issuer}/token`]: (init) => {
      const body = new URLSearchParams(String(init?.body));
      const code = codes.get(String(body.get("code")))!;
      // The code goes once, to the client that holds the verifier of its challenge.
      codes.delete(String(body.get("code")));
      expect(
        createHash("sha256")
          .update(String(body.get("code_verifier")))
          .digest("base64url"),
      ).toBe(code.challenge);
      return Response.json({
        access_token: "fake-access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken({ ...code.claims, nonce: code.nonce }),
      });
    },
  };
  if (oidc)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => routes[String(input)]!(init)),
    );

  /** The server with a mail provider, and the same data served as before one was configured. */
  const serve = (withMail: boolean) => {
    const auth = createAuth(prisma as never, {
      secret: SECRET,
      baseURL: origin,
      webOrigin: web,
      signupsEnabled: signups,
      signupAllowlist: allowlist,
      singleAccount,
      ...(oidc
        ? {
            oidc: {
              issuer,
              clientId: "test-client",
              clientSecret: "test-client-secret",
              name: "SSO",
              scopes: ["openid", "email", "profile"],
              allowSignupBypass: false,
            },
          }
        : {}),
      ...(google
        ? {
            social: {
              providers: [
                {
                  id: "google" as const,
                  name: "Google",
                  clientId: GOOGLE_CLIENT,
                  clientSecret: "offline-secret",
                },
              ],
            },
          }
        : {}),
      ...(withMail
        ? {
            email: {
              describe: () => ({
                id: "offline-email",
                contractVersion: "1",
                adapterVersion: "1",
                capabilities: { transactional: true },
              }),
              send: async (message: TransactionalEmail) => {
                messages.push(message);
              },
            },
          }
        : {}),
    });
    disposers.push(() => auth.disposeOidcDiscovery());
    const call = (
      path: string,
      body?: unknown,
      cookie?: string,
      headers: Record<string, string> = {},
    ) =>
      auth.handler(
        new Request(`${origin}/api/auth${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            "content-type": "application/json",
            origin: web,
            ...(cookie ? { cookie } : {}),
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
      );
    return { auth, call };
  };
  const main = serve(true);
  /** Signing up here still opens a session: how every account before the mail provider was made. */
  const legacy = serve(false);
  const { auth, call } = main;
  const cookieOf = (response: Response, jar = "") => {
    const cookies = new Map(
      jar
        .split("; ")
        .filter(Boolean)
        .map((pair) => [pair.split("=")[0], pair] as const),
    );
    for (const set of response.headers.getSetCookie()) {
      const pair = set.split(";")[0] as string;
      const name = pair.split("=")[0] as string;
      if (/max-age=0/i.test(set) || pair.endsWith("=")) cookies.delete(name);
      else cookies.set(name, pair);
    }
    return [...cookies.values()].join("; ");
  };
  const register = (address = email, cookie?: string, server = main, pass = password) =>
    server.call("/sign-up/email", { email: address, password: pass, name: "Ada" }, cookie);
  const signUp = async (address = email, cookie?: string, server = main) => {
    const response = await register(address, cookie, server);
    expect(response.status).toBe(200);
    return cookieOf(response);
  };
  const signIn = (cookie?: string, pass = password, address = email) =>
    call("/sign-in/email", { email: address, password: pass }, cookie);
  const mailsTo = (address: string) =>
    messages.filter((m) => m.to === address && m.text.includes("/verify-email?"));
  /** Opens the link of the last verification mail, in a browser holding `cookie` or none. */
  const openLink = async (cookie?: string, edit = (_url: URL) => {}, address = email) => {
    // The mail goes out in the background.
    const mail = await vi.waitFor(() => {
      const found = mailsTo(address).at(-1);
      expect(found).toBeDefined();
      return found as TransactionalEmail;
    });
    const url = new URL(mail.text.match(/https?:\/\/\S+/)![0]);
    edit(url);
    return call(`${url.pathname.replace("/api/auth", "")}${url.search}`, undefined, cookie);
  };
  const user = async (cookie: string) =>
    (await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user ?? null;
  /** The stored account, whatever sessions exist. */
  const stored = (address = email) => prisma.authData.user.find((row) => row.email === address);
  /** An account made before the mail provider, signed in on one browser: its session and its mail. */
  const oldAccount = async (address = email) => {
    const session = await signUp(address, undefined, legacy);
    // The mail the account has not had yet: a password sign-in now asks for verification.
    expect((await signIn(undefined, password, address)).status).toBe(403);
    await vi.waitFor(() => expect(mailsTo(address)).toHaveLength(1));
    return session;
  };
  /**
   * A new account, verified the way the page does it: the link, then the password, in one
   * browser. Returns that browser's session.
   */
  const verifiedAccount = async (address: string) => {
    await signUp(address);
    const browser = cookieOf(await openLink(undefined, undefined, address));
    const signedIn = await signIn(browser, password, address);
    expect(signedIn.status).toBe(200);
    expect(stored(address)).toMatchObject({ emailVerified: true });
    return cookieOf(signedIn, browser);
  };
  /** Asks for a sign-in code for `address` in a browser holding `cookie`, and reads it from the mail. */
  const signInCode = async (address = email, cookie?: string) => {
    const before = messages.length;
    const asked = await call(
      "/email-otp/send-verification-otp",
      { email: address, type: "sign-in" },
      cookie,
    );
    expect(asked.status).toBe(200);
    const mail = await vi.waitFor(() => {
      const found = messages
        .slice(before)
        .findLast((m) => m.to === address && !m.text.includes("/verify-email?"));
      expect(found).toBeDefined();
      return found as TransactionalEmail;
    });
    return mail.text.match(/\b(\d{6})\b/)![1] as string;
  };
  /** Signs in with an emailed code, in a browser holding `cookie` or none. */
  const codeSignIn = async (address = email, cookie?: string) =>
    call("/sign-in/email-otp", { email: address, otp: await signInCode(address, cookie) }, cookie);

  /**
   * Starts a sign-in (or, with `link`, a link to the browser's session) at the fake identity
   * provider or Google, and has the provider sign `claims`. Returns the callback path and the
   * browser's cookies after the start.
   */
  const startProvider = async (
    provider: "oidc" | "google",
    claims: Record<string, unknown>,
    { link = false, cookie = "", callbackURL = `${web}/app` } = {},
  ) => {
    const started = await call(
      link ? "/link-social" : "/sign-in/social",
      { provider, callbackURL, errorCallbackURL: `${web}/sign-in`, disableRedirect: true },
      cookie,
    );
    expect(started.status, await started.clone().text()).toBe(200);
    const authorization = new URL(((await started.json()) as { url: string }).url);
    const state = authorization.searchParams.get("state");
    const nonce = authorization.searchParams.get("nonce") as string;
    const code = `code-${randomBytes(6).toString("hex")}`;
    if (provider === "oidc") {
      codes.set(code, {
        challenge: authorization.searchParams.get("code_challenge") as string,
        nonce,
        claims,
      });
    } else {
      // Only the provider's network is replaced; Better Auth's sign-in and link policy stays.
      const google = (await auth.$context).socialProviders.find((item) => item.id === "google")!;
      Object.assign(google.idToken as object, { jwks: async () => publicKey });
      google.validateAuthorizationCode = async () => ({
        accessToken: "offline-token",
        tokenType: "Bearer",
        idToken: idToken({ iss: GOOGLE_ISSUER, aud: GOOGLE_CLIENT, nonce, ...claims }),
      });
    }
    return {
      callback: `/callback/${provider}?state=${state}&code=${code}`,
      authorizeURL: `${provider === "oidc" ? `${issuer}/authorize` : `${GOOGLE_ISSUER}/o/oauth2/v2/auth`}?state=${state}`,
      cookie: cookieOf(started, cookie),
    };
  };
  /** Signs in (or links) with a provider through the browser callback; the answer and the cookies. */
  const providerSignIn = async (
    provider: "oidc" | "google",
    claims: Record<string, unknown>,
    options: { link?: boolean; cookie?: string } = {},
  ) => {
    const started = await startProvider(provider, claims, options);
    const response = await call(started.callback, undefined, started.cookie);
    return { response, cookie: cookieOf(response, started.cookie) };
  };
  const accountsOf = (address = email) =>
    prisma.authData.account.filter((row) => row.userId === stored(address)?.id);

  return {
    prisma,
    messages,
    devices,
    banned,
    members,
    legacy,
    auth,
    call,
    cookieOf,
    register,
    signUp,
    signIn,
    openLink,
    user,
    stored,
    mailsTo,
    oldAccount,
    verifiedAccount,
    signInCode,
    codeSignIn,
    startProvider,
    providerSignIn,
    accountsOf,
  };
}

export type Fixture = ReturnType<typeof fixture>;

/** The passkey plugin's challenge cookie, as upstream's `identity-trust.test.ts` reads it. */
export function challengeCookie(response: Response): string {
  const cookie = String(response.headers.get("set-cookie"));
  return cookie.match(/(?:__Secure-)?better-auth\.better-auth-passkey=[^;]+/)![0];
}

/**
 * Minimal offline platform authenticator: "none" attestation, ES256, one credential. A copy of
 * upstream's in `identity-trust.test.ts`, which a fork test cannot import.
 */
export function softwareAuthenticator(rpId: string, origin: string) {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = keys.publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(16);
  const id = credentialId.toString("base64url");
  const rpIdHash = createHash("sha256").update(rpId).digest();
  let counter = 0;
  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const counterBytes = () => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(counter);
    return bytes;
  };
  return {
    create(challenge: string) {
      const coseKey = cbor(
        new Map<number, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(key.x!, "base64url")],
          [-3, Buffer.from(key.y!, "base64url")],
        ]),
      );
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        rpIdHash,
        Buffer.from([0x45]),
        counterBytes(),
        Buffer.alloc(16),
        length,
        credentialId,
        coseKey,
      ]);
      const attestationObject = cbor(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: clientData("webauthn.create", challenge).toString("base64url"),
          attestationObject: attestationObject.toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    get(challenge: string) {
      counter += 1;
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), counterBytes()]);
      const data = clientData("webauthn.get", challenge);
      const signature = sign(
        "sha256",
        Buffer.concat([authData, createHash("sha256").update(data).digest()]),
        keys.privateKey,
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: data.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      };
    },
  };
}

/** CBOR for the handful of types WebAuthn attestation needs: numbers, strings, bytes and maps. */
function cbor(value: unknown): Buffer {
  // Lengths under 256 are all an attestation of this authenticator needs.
  const head = (major: number, length: number) =>
    Buffer.from(length < 24 ? [(major << 5) | length] : [(major << 5) | 24, length]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  const map = value as Map<unknown, unknown>;
  return Buffer.concat([
    head(5, map.size),
    ...[...map].flatMap(([key, item]) => [cbor(key), cbor(item)]),
  ]);
}
