import type { KeyObject } from "node:crypto";
import { generateKeyPairSync, sign } from "node:crypto";
import { deferred } from "@rakazo/core/test-async";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostedLoginClaims, HostedLoginConfig } from "./dozo-hosted-login.js";
import {
  CLOCK_LEEWAY_SECONDS,
  closedOnLocalServer,
  dozoHostedLogin,
  HOSTED_PROVIDER_ID,
  HostedLoginError,
  hostedLoginConfig,
  hostedLoginOnly,
  installLock,
  issuerKeys,
  issuerOrigin,
  KEY_REFRESH_SECONDS,
  KEY_RETRY_SECONDS,
  loopbackCallback,
  MAX_KEYS_BYTES,
  publicJwk,
  refuseUnlinkedAccounts,
  signingKeyFrom,
  signLoginToken,
  TOKEN_LIFETIME_SECONDS,
  TOKEN_TYPE,
  verifyLoginToken,
} from "./dozo-hosted-login.js";

const HOSTED = "https://accounts.dozo.example";
const LOCAL = "http://127.0.0.1:5173";
const SECRET = "offline-auth-secret-at-least-32-characters";
const NOW = Date.UTC(2026, 10, 20, 12);
const AUDIENCE = "a".repeat(43);
const CALLBACK = `${LOCAL}/api/auth/dozo/hosted-login/callback`;

const ed25519 = () => generateKeyPairSync("ed25519").privateKey;
const pem = (key: KeyObject) => String(key.export({ format: "pem", type: "pkcs8" }));
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

afterEach(() => {
  vi.useRealTimers();
});

const claims = {
  iss: HOSTED,
  sub: "hosted-user-1",
  aud: AUDIENCE,
  email: "ada@dozo.example",
  email_verified: true,
  name: "Ada",
};

function keyring(...keys: KeyObject[]) {
  const byKid = new Map(keys.map((key) => [publicJwk(key).kid, key]));
  return async (kid: string) => byKid.get(kid) ?? null;
}

/** A token with any header and payload, signed by `key`. */
function forge(key: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>) {
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${b64(sign(null, Buffer.from(input), key))}`;
}

describe("configuration", () => {
  it("has no mode when neither variable is set, so nothing changes", () => {
    expect(hostedLoginConfig({})).toBeNull();
    expect(dozoHostedLogin({ prisma: {} as never, webOrigin: LOCAL, config: null })).toEqual([]);
    expect(dozoHostedLogin({ prisma: {} as never, webOrigin: LOCAL })).toEqual([]);
  });

  it("reads the signing key as PEM, PEM with escaped newlines, or base64 DER", () => {
    const key = ed25519();
    const kid = publicJwk(key).kid;
    const der = key.export({ format: "der", type: "pkcs8" }).toString("base64");
    for (const value of [pem(key), pem(key).replaceAll("\n", "\\n"), der]) {
      const config = hostedLoginConfig({ HOSTED_LOGIN_SIGNING_KEY: value });
      expect(config?.mode).toBe("issuer");
      expect(config?.mode === "issuer" && publicJwk(config.signingKey).kid).toBe(kid);
    }
  });

  it("refuses a key of another algorithm, both variables, and an issuer that is not an https origin", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(() => signingKeyFrom(pem(rsa))).toThrow(/Ed25519/);
    expect(() =>
      hostedLoginConfig({ HOSTED_LOGIN_SIGNING_KEY: pem(ed25519()), HOSTED_LOGIN_ISSUER: HOSTED }),
    ).toThrow(/not both/);
    for (const bad of ["http://accounts.dozo.example", `${HOSTED}/path`, `${HOSTED}?x=1`])
      expect(() => issuerOrigin(bad)).toThrow(/https origin/);
    expect(hostedLoginConfig({ HOSTED_LOGIN_ISSUER: `${HOSTED}/` })).toEqual({
      mode: "verifier",
      issuer: HOSTED,
    });
    expect(issuerOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("returns a token only to the loopback callback", () => {
    expect(loopbackCallback(CALLBACK)?.href).toBe(CALLBACK);
    expect(
      loopbackCallback("http://localhost:1/api/auth/dozo/hosted-login/callback"),
    ).not.toBeNull();
    expect(loopbackCallback("http://[::1]:9/api/auth/dozo/hosted-login/callback")).not.toBeNull();
    for (const bad of [
      "https://evil.example/api/auth/dozo/hosted-login/callback",
      "http://127.0.0.1.evil.example/api/auth/dozo/hosted-login/callback",
      "http://user:pass@127.0.0.1/api/auth/dozo/hosted-login/callback",
      "https://127.0.0.1/api/auth/dozo/hosted-login/callback",
      `${LOCAL}/elsewhere`,
      `${CALLBACK}?next=https://evil.example`,
      `${CALLBACK}#x`,
      "http://localhost./api/auth/dozo/hosted-login/callback",
      "http://127.1/api/auth/dozo/hosted-login/callback",
      "http://0x7f000001/api/auth/dozo/hosted-login/callback",
      "http://127.0.0.1\\@evil.example/api/auth/dozo/hosted-login/callback",
      "http://127.0.0.1:5173\\api\\auth\\dozo\\hosted-login\\callback",
      "http://127.0.0.1/api/auth/dozo/hosted-login%2Fcallback",
      "http://127.0.0.1/api/auth/dozo/x/../hosted-login/callback",
      "HTTP://127.0.0.1/api/auth/dozo/hosted-login/callback",
      "javascript:alert(1)",
      "not a url",
    ])
      expect(loopbackCallback(bad)).toBeNull();
  });
});

describe("the login token", () => {
  const key = ed25519();
  const expected = { issuer: HOSTED, audience: AUDIENCE, keyFor: keyring(key) };

  it("round-trips the claims while it lives", async () => {
    const token = signLoginToken(key, claims, NOW);
    const read = await verifyLoginToken(token, expected, NOW);
    expect(read).toMatchObject({ ...claims, v: 1 });
    expect(read.exp - read.iat).toBe(TOKEN_LIFETIME_SECONDS);
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString())).toEqual({
      alg: "EdDSA",
      typ: TOKEN_TYPE,
      kid: publicJwk(key).kid,
    });
  });

  it("tolerates a skewed local clock only within the leeway", async () => {
    const token = signLoginToken(key, claims, NOW);
    const late = NOW + (TOKEN_LIFETIME_SECONDS + CLOCK_LEEWAY_SECONDS) * 1000;
    const early = NOW - CLOCK_LEEWAY_SECONDS * 1000;
    await expect(verifyLoginToken(token, expected, late)).resolves.toBeTruthy();
    await expect(verifyLoginToken(token, expected, early)).resolves.toBeTruthy();
    await expect(verifyLoginToken(token, expected, late + 1000)).rejects.toThrow(/expired/);
    await expect(verifyLoginToken(token, expected, early - 1000)).rejects.toThrow(/expired/);
  });

  it.each([
    [
      "another install's audience",
      () => signLoginToken(key, { ...claims, aud: "b".repeat(43) }, NOW),
      "audience",
    ],
    [
      "another issuer",
      () => signLoginToken(key, { ...claims, iss: "https://other.example" }, NOW),
      "issuer",
    ],
    [
      "a key the issuer does not publish",
      () => signLoginToken(ed25519(), claims, NOW),
      "unknown key",
    ],
    [
      "a key id swapped onto another key's signature",
      () => {
        const other = signLoginToken(ed25519(), claims, NOW).split(".");
        const header = b64(
          JSON.stringify({ alg: "EdDSA", typ: TOKEN_TYPE, kid: publicJwk(key).kid }),
        );
        return `${header}.${other[1]}.${other[2]}`;
      },
      "signature",
    ],
    [
      "a changed payload",
      () => {
        const [h, , s] = signLoginToken(key, claims, NOW).split(".");
        return `${h}.${b64(JSON.stringify({ ...claims, sub: "someone-else" }))}.${s}`;
      },
      "signature",
    ],
    [
      "an HMAC algorithm",
      () => forge(key, { alg: "HS256", typ: TOKEN_TYPE, kid: publicJwk(key).kid }, {}),
      "header",
    ],
    [
      "no algorithm",
      () => forge(key, { alg: "none", typ: TOKEN_TYPE, kid: publicJwk(key).kid }, {}),
      "header",
    ],
    [
      "another token type",
      () => forge(key, { alg: "EdDSA", typ: "JWT", kid: publicJwk(key).kid }, {}),
      "header",
    ],
    [
      "no signature",
      () => `${signLoginToken(key, claims, NOW).split(".").slice(0, 2).join(".")}.`,
      "signature",
    ],
    ["two parts", () => "a.b", "malformed"],
    ["a payload that is not an object", () => `${b64("[1]")}.${b64("{}")}.x`, "malformed"],
    ["a payload that is not JSON", () => `${b64("{")}.${b64("{}")}.x`, "malformed"],
    ["an oversized token", () => `${"a".repeat(5000)}.b.c`, "malformed"],
  ])("refuses %s", async (_name, make, reason) => {
    const error = await verifyLoginToken(make(), expected, NOW).catch((caught) => caught);
    expect(error).toBeInstanceOf(HostedLoginError);
    expect((error as HostedLoginError).reason).toBe(reason);
  });

  const at = Math.floor(NOW / 1000);
  const base = { v: 1, ...claims, iat: at, exp: at + 60, jti: "j" };
  const header = { alg: "EdDSA", typ: TOKEN_TYPE, kid: publicJwk(key).kid };
  it.each<[string, Partial<Record<keyof HostedLoginClaims, unknown>>, string]>([
    ["another version", { v: 2 }, "version"],
    ["a lifetime over a minute", { exp: at + 61 }, "lifetime"],
    ["an end before its start", { exp: at }, "lifetime"],
    ["times that are not whole seconds", { iat: at + 0.5 }, "lifetime"],
    ["no subject", { sub: "" }, "claims"],
    ["an address without @", { email: "ada" }, "claims"],
    ["no name", { name: 3 }, "claims"],
    ["no verification flag", { email_verified: "yes" }, "claims"],
    ["no token id", { jti: undefined }, "claims"],
  ])("refuses a signed token with %s", async (_name, change, reason) => {
    const error = await verifyLoginToken(
      forge(key, header, { ...base, ...change }),
      expected,
      NOW,
    ).catch((caught) => caught);
    expect((error as HostedLoginError).reason).toBe(reason);
  });
});

describe("the issuer's keys on the local server", () => {
  const key = ed25519();
  const jwk = publicJwk(key);
  const answer = (body: unknown, status = 200) =>
    vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
    );

  it("fetches them from the issuer once and keeps only Ed25519 keys whose id is their own", async () => {
    const other = publicJwk(ed25519());
    const fetcher = answer({
      keys: [jwk, { ...other, kid: jwk.kid.replace(/^./, "x") }, { ...other, crv: "X25519" }, null],
    });
    const keyFor = issuerKeys(HOSTED, fetcher as typeof fetch);
    expect(await keyFor(jwk.kid, NOW)).not.toBeNull();
    expect(await keyFor(jwk.kid, NOW + 1)).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${HOSTED}/api/auth/dozo/hosted-login/keys`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("asks again for an unknown key at most once a minute, which picks up a rotated key", async () => {
    const next = ed25519();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [publicJwk(next)] })));
    const keyFor = issuerKeys(HOSTED, fetcher);
    expect(await keyFor(publicJwk(next).kid, NOW)).toBeNull();
    expect(await keyFor(publicJwk(next).kid, NOW + 1000)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const later = NOW + KEY_REFRESH_SECONDS * 1000;
    expect(await keyFor(publicJwk(next).kid, later)).not.toBeNull();
    expect(await keyFor(jwk.kid, later + 1)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("shares one request among everyone waiting for it", async () => {
    const fetcher = answer({ keys: [jwk] });
    const keyFor = issuerKeys(HOSTED, fetcher as typeof fetch);
    const found = await Promise.all([keyFor(jwk.kid, NOW), keyFor(jwk.kid, NOW), keyFor("x", NOW)]);
    expect(found.map(Boolean)).toEqual([true, true, false]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("after a failure tries again a few seconds later, not a minute", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [jwk] })));
    const keyFor = issuerKeys(HOSTED, fetcher);
    await expect(keyFor(jwk.kid, NOW)).rejects.toThrow(/HTTP 503/);
    expect(await keyFor(jwk.kid, NOW + 1000)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await keyFor(jwk.kid, NOW + KEY_RETRY_SECONDS * 1000)).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refuses an answer that is too large or not a key list", async () => {
    const huge = vi.fn(async () => new Response("x".repeat(MAX_KEYS_BYTES + 1)));
    await expect(issuerKeys(HOSTED, huge as never)("k", NOW)).rejects.toThrow(/too large/);
    expect(await issuerKeys(HOSTED, answer({ keys: "no" }) as typeof fetch)("k", NOW)).toBeNull();
  });
});

describe("the start check of a local server", () => {
  const users = (count: number) => ({ user: { count: vi.fn(async () => count) } });
  const verifier: HostedLoginConfig = { mode: "verifier", issuer: HOSTED };

  it("refuses a server that already has accounts of its own", async () => {
    const prisma = users(2);
    await expect(refuseUnlinkedAccounts(prisma as never, verifier)).rejects.toThrow(
      /HOSTED_LOGIN_ISSUER is set, but this server has 2 account/,
    );
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        NOT: { email: { endsWith: "@messaging.invalid" } },
        accounts: { none: { providerId: HOSTED_PROVIDER_ID } },
      },
    });
  });

  it("starts with hosted accounts only, and asks nothing in another mode", async () => {
    await expect(refuseUnlinkedAccounts(users(0) as never, verifier)).resolves.toBeUndefined();
    const prisma = users(5);
    await refuseUnlinkedAccounts(prisma as never, null);
    await refuseUnlinkedAccounts(prisma as never, { mode: "issuer", signingKey: ed25519() });
    expect(prisma.user.count).not.toHaveBeenCalled();
  });
});

describe("the install lock", () => {
  it("runs the work inside a transaction that holds a Postgres advisory lock", async () => {
    const executeRaw = vi.fn(async (_sql: TemplateStringsArray) => 1);
    const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>, _options: unknown) =>
      work({ $executeRaw: executeRaw }),
    );
    const lock = installLock({ $transaction: transaction } as never);
    expect(await lock(async () => "done")).toBe("done");
    expect(executeRaw.mock.calls[0]?.[0].join("")).toContain("pg_advisory_xact_lock");
    expect(transaction.mock.calls[0]?.[1]).toEqual({ timeout: 30_000 });
  });
});

describe("the capability the sign-in page reads", () => {
  it("says hosted-only on a local server and nowhere else", () => {
    expect(hostedLoginOnly({ mode: "verifier", issuer: HOSTED })).toBe(true);
    expect(hostedLoginOnly({ mode: "issuer", signingKey: ed25519() })).toBe(false);
    expect(hostedLoginOnly(null)).toBe(false);
  });
});

describe("what a local server closes", () => {
  it.each([
    "/sign-in/email",
    "/sign-up/email",
    "/sign-in/email-otp",
    "/sign-in/social",
    "/sign-in/oauth2",
    "/sign-in/passkey",
    "/passkey/generate-register-options",
    "/passkey/verify-authentication",
    "/email-otp/send-verification-otp",
    "/forget-password/email-otp",
    "/callback/oidc",
    "/oauth2/callback/oidc",
    "/request-password-reset",
    "/reset-password",
    "/reset-password/:token",
    "/change-password",
    "/set-password",
    "/change-email",
    "/link-social",
    "/send-verification-email",
    "/verify-email",
  ])("closes %s", (path) => {
    expect(closedOnLocalServer(path)).toBe(true);
  });

  it.each([
    "/get-session",
    "/sign-out",
    "/list-sessions",
    "/revoke-session",
    "/dozo/hosted-login/start",
    "/dozo/hosted-login/callback",
  ])("keeps %s", (path) => {
    expect(closedOnLocalServer(path)).toBe(false);
  });
});

type Row = Record<string, unknown>;
type Store = Record<"user" | "session" | "account" | "verification" | "rateLimit", Row[]>;
type Handler = { handler: (request: Request) => Promise<Response> };
const store = (): Store => ({
  user: [],
  session: [],
  account: [],
  verification: [],
  rateLimit: [],
});

/** One piece of work at a time, as the advisory lock gives across processes. */
function mutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** The hosted server; its API may answer on another origin than its web app. */
function hostedServer(key: KeyObject, rateLimit = false, baseURL = HOSTED) {
  const data = store();
  const auth = betterAuth({
    secret: SECRET,
    baseURL,
    trustedOrigins: [HOSTED],
    database: memoryAdapter(data),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: rateLimit, storage: "database" },
    plugins: dozoHostedLogin({
      prisma: {} as never,
      webOrigin: HOSTED,
      config: { mode: "issuer", signingKey: key },
    }),
  });
  return { auth, data };
}

type LocalOptions = {
  refuse?: (userId: string) => boolean;
  beforeCreate?: () => Promise<void>;
  lock?: <T>(work: () => Promise<T>) => Promise<T>;
  rateLimit?: boolean;
};

function localServer(fetcher: typeof fetch, options: LocalOptions = {}) {
  const data = store();
  const auth = betterAuth({
    secret: SECRET,
    baseURL: LOCAL,
    database: memoryAdapter(data),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: options.rateLimit ?? false, storage: "database" },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            await options.beforeCreate?.();
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            if (options.refuse?.(session.userId))
              throw new APIError("FORBIDDEN", { code: "REGISTRATION_CLOSED" });
          },
        },
      },
    },
    plugins: dozoHostedLogin({
      prisma: {} as never,
      webOrigin: LOCAL,
      config: { mode: "verifier", issuer: HOSTED },
      fetcher,
      lock: options.lock ?? mutex(),
    }),
  });
  return { auth, data };
}

const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

async function signUp(auth: Handler, email: string, name: string) {
  const response = await auth.handler(
    new Request(`${HOSTED}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: HOSTED },
      body: JSON.stringify({ email, name, password: "a-long-enough-password" }),
    }),
  );
  expect(response.status).toBe(200);
  return cookieHeader(response);
}

/** What the local sign-in page sends to start. */
function startRequest(headers: Record<string, string> = { origin: LOCAL }) {
  return new Request(`${LOCAL}/api/auth/dozo/hosted-login/start`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

function issueRequest(body: unknown, headers: Record<string, string>) {
  return new Request(`${HOSTED}/api/auth/dozo/hosted-login/issue`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** The two servers, the browser's cookies for each, and one full sign-in. */
function world(options: LocalOptions = {}) {
  const key = ed25519();
  const hosted = hostedServer(key);
  const fetcher = vi.fn(async (input: string | URL | Request) =>
    hosted.auth.handler(new Request(String(input))),
  ) as unknown as typeof fetch;
  const local = localServer(fetcher, options);
  const get = (auth: Handler, url: string, cookie = "") =>
    auth.handler(new Request(url, { headers: cookie ? { cookie } : {} }));

  async function start() {
    const response = await local.auth.handler(startRequest());
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    return { page: new URL(url), cookie: cookieHeader(response) };
  }

  /** What the hosted page sends once the user agrees: the callback address with the token. */
  async function agree(page: URL, hostedCookie: string) {
    const response = await hosted.auth.handler(
      issueRequest(
        {
          audience: page.searchParams.get("audience"),
          return: page.searchParams.get("return"),
        },
        { cookie: hostedCookie, origin: HOSTED },
      ),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { url: string }).url;
  }

  async function signIn(hostedCookie: string) {
    const started = await start();
    const callback = await agree(started.page, hostedCookie);
    const done = await get(local.auth, callback, started.cookie);
    return { started, callback, done };
  }

  return { key, hosted, local, fetcher, get, start, agree, signIn };
}

const location = (response: Response) => response.headers.get("location");
const FAILED = `${LOCAL}/sign-in?error=hosted_login_failed`;
const payloadOf = (callback: string) =>
  JSON.parse(
    Buffer.from(
      new URL(callback).searchParams.get("token")!.split(".")[1]!,
      "base64url",
    ).toString(),
  ) as HostedLoginClaims;
const userRow = (id: string, email: string) => ({
  id,
  email,
  name: "Local",
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("signing in to a local server with the hosted account", () => {
  it("creates the local user from the hosted account and opens a session", async () => {
    const w = world();
    const hostedCookie = await signUp(w.hosted.auth, "Ada@Dozo.example", "Ada");
    const { started, callback, done } = await w.signIn(hostedCookie);

    expect(started.page.origin).toBe(HOSTED);
    expect(started.page.pathname).toBe("/dozo/hosted-login");
    expect(started.page.searchParams.get("return")).toBe(CALLBACK);
    expect(started.cookie).toMatch(/dozo_hosted_login=/);
    expect(callback.startsWith(`${CALLBACK}?token=`)).toBe(true);
    const hostedUser = w.hosted.data.user[0]!;
    expect(payloadOf(callback)).toMatchObject({
      sub: hostedUser.id,
      email: "ada@dozo.example",
      iss: HOSTED,
    });
    expect(done.status).toBe(302);
    expect(location(done)).toBe(`${LOCAL}/`);
    expect(done.headers.get("cache-control")).toBe("no-store");

    const [user] = w.local.data.user;
    expect(user).toMatchObject({ email: "ada@dozo.example", name: "Ada", emailVerified: false });
    expect(w.local.data.account).toEqual([
      expect.objectContaining({
        providerId: HOSTED_PROVIDER_ID,
        accountId: hostedUser.id,
        userId: user!.id,
      }),
    ]);
    const session = await w.local.auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader(done) }),
    });
    expect(session?.user.id).toBe(user!.id);
    expect(w.local.data.verification).toEqual([]);
  });

  it("keeps the same local user when the hosted address and name change", async () => {
    const w = world();
    const hostedCookie = await signUp(w.hosted.auth, "ada@dozo.example", "Ada");
    await w.signIn(hostedCookie);
    const localId = w.local.data.user[0]!.id;
    Object.assign(w.hosted.data.user[0]!, { email: "lovelace@dozo.example", name: "Ada L" });
    const { done } = await w.signIn(hostedCookie);
    expect(location(done)).toBe(`${LOCAL}/`);
    expect(w.local.data.user).toEqual([
      expect.objectContaining({ id: localId, email: "lovelace@dozo.example", name: "Ada L" }),
    ]);
  });

  it("keeps the old address when another local user already has the new one", async () => {
    const w = world();
    const hostedCookie = await signUp(w.hosted.auth, "ada@dozo.example", "Ada");
    await w.signIn(hostedCookie);
    w.local.data.user.push(userRow("other", "taken@dozo.example"));
    Object.assign(w.hosted.data.user[0]!, { email: "taken@dozo.example" });
    const { done } = await w.signIn(hostedCookie);
    expect(location(done)).toBe(`${LOCAL}/`);
    expect(w.local.data.user[0]).toMatchObject({ email: "ada@dozo.example" });
  });

  it("locks the install to the first hosted account", async () => {
    const w = world();
    await w.signIn(await signUp(w.hosted.auth, "ada@dozo.example", "Ada"));
    const { done } = await w.signIn(await signUp(w.hosted.auth, "eve@dozo.example", "Eve"));
    expect(location(done)).toBe(FAILED);
    expect(w.local.data.user).toHaveLength(1);
    expect(w.local.data.account).toHaveLength(1);
  });

  it("lets only one of two first sign-ins at the same time take the install", async () => {
    // The first creation waits until the second sign-in has asked for the lock, so without one
    // both would find the install free.
    const second = deferred();
    const lock = mutex();
    let calls = 0;
    let creations = 0;
    const w = world({
      lock: (work) => {
        calls += 1;
        if (calls === 2) second.resolve();
        return lock(work);
      },
      beforeCreate: async () => {
        creations += 1;
        if (creations === 1) await second.promise;
      },
    });
    const ada = await signUp(w.hosted.auth, "ada@dozo.example", "Ada");
    const eve = await signUp(w.hosted.auth, "eve@dozo.example", "Eve");
    const [a, e] = await Promise.all([w.start(), w.start()]);
    const [toA, toE] = await Promise.all([w.agree(a.page, ada), w.agree(e.page, eve)]);
    const done = await Promise.all([
      w.get(w.local.auth, toA, a.cookie),
      w.get(w.local.auth, toE, e.cookie),
    ]);
    expect(done.map(location).sort()).toEqual([`${LOCAL}/`, FAILED].sort());
    expect(w.local.data.user).toHaveLength(1);
    expect(w.local.data.account).toHaveLength(1);
  });

  it("does not take over a local account that only shares the address", async () => {
    const w = world();
    w.local.data.user.push(userRow("local", "ada@dozo.example"));
    w.local.data.account.push({
      id: "credential",
      userId: "local",
      providerId: "credential",
      accountId: "local",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { done } = await w.signIn(await signUp(w.hosted.auth, "ada@dozo.example", "Ada"));
    expect(location(done)).toBe(FAILED);
    expect(w.local.data.account).toHaveLength(1);
  });

  it("links the user a cut-off first sign-in left without its link, instead of locking it out", async () => {
    const w = world();
    // What a crash between the two writes leaves: the user, and no account of any kind.
    w.local.data.user.push(userRow("orphan", "ada@dozo.example"));
    const { done } = await w.signIn(await signUp(w.hosted.auth, "ada@dozo.example", "Ada"));
    expect(location(done)).toBe(`${LOCAL}/`);
    expect(w.local.data.user.map((user) => user.id)).toEqual(["orphan"]);
    expect(w.local.data.account).toEqual([
      expect.objectContaining({ userId: "orphan", providerId: HOSTED_PROVIDER_ID }),
    ]);
  });

  it("starts only from its own page, and a page elsewhere writes nothing", async () => {
    const w = world();
    const elsewhere: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "null" },
      {},
    ];
    for (const headers of elsewhere) {
      const response = await w.local.auth.handler(startRequest(headers));
      expect(response.status).toBe(403);
    }
    const opened = await w.get(w.local.auth, `${LOCAL}/api/auth/dozo/hosted-login/start`);
    expect(opened.status).not.toBe(200);
    expect(opened.headers.getSetCookie()).toEqual([]);
    expect(w.local.data.verification).toEqual([]);
  });

  it("keeps a sign-in going when a stray callback arrives first", async () => {
    const w = world();
    const hostedCookie = await signUp(w.hosted.auth, "ada@dozo.example", "Ada");
    const started = await w.start();
    const callback = await w.agree(started.page, hostedCookie);
    const stray = await w.get(w.local.auth, `${CALLBACK}?token=x`, started.cookie);
    expect(location(stray)).toBe(FAILED);
    expect(stray.headers.getSetCookie()).toEqual([]);
    expect(location(await w.get(w.local.auth, callback, started.cookie))).toBe(`${LOCAL}/`);
  });

  it("removes the user it created when the session is refused", async () => {
    const w = world({ refuse: () => true });
    const { done } = await w.signIn(await signUp(w.hosted.auth, "ada@dozo.example", "Ada"));
    expect(location(done)).toBe(FAILED);
    expect(w.local.data.user).toEqual([]);
    expect(w.local.data.account).toEqual([]);
  });

  it("answers a refused account creation like any other failure, leaving nothing behind", async () => {
    const w = world({
      beforeCreate: async () => {
        throw new APIError("BAD_REQUEST", { code: "NO" });
      },
    });
    const { done } = await w.signIn(await signUp(w.hosted.auth, "ada@dozo.example", "Ada"));
    expect(location(done)).toBe(FAILED);
    expect(w.local.data.user).toEqual([]);
    expect(w.local.data.account).toEqual([]);
  });

  it("refuses a token used twice, also at the same time", async () => {
    const w = world();
    const hostedCookie = await signUp(w.hosted.auth, "ada@dozo.example", "Ada");
    const started = await w.start();
    const callback = await w.agree(started.page, hostedCookie);
    const both = await Promise.all([
      w.get(w.local.auth, callback, started.cookie),
      w.get(w.local.auth, callback, started.cookie),
    ]);
    expect(both.map(location).sort()).toEqual([`${LOCAL}/`, FAILED].sort());
    expect(location(await w.get(w.local.auth, callback, started.cookie))).toBe(FAILED);
    expect(w.local.data.session).toHaveLength(1);
  });

  it("refuses a token in a browser that did not start the sign-in", async () => {
    const w = world();
    const hostedCookie = await signUp(w.hosted.auth, "ada@dozo.example", "Ada");
    const started = await w.start();
    const callback = await w.agree(started.page, hostedCookie);
    expect(location(await w.get(w.local.auth, callback))).toBe(FAILED);
    // Another browser's own sign-in nonce does not stand in for this one.
    const other = await w.start();
    expect(location(await w.get(w.local.auth, callback, other.cookie))).toBe(FAILED);
    expect(w.local.data.user).toEqual([]);
  });

  it("refuses a nonce that expired before the token came back", async () => {
    const w = world();
    const hostedCookie = await signUp(w.hosted.auth, "ada@dozo.example", "Ada");
    const started = await w.start();
    const callback = await w.agree(started.page, hostedCookie);
    for (const row of w.local.data.verification) row.expiresAt = new Date(Date.now() - 1000);
    expect(location(await w.get(w.local.auth, callback, started.cookie))).toBe(FAILED);
  });

  it("removes started sign-ins nobody finished when the next one starts", async () => {
    const w = world();
    const old = { createdAt: new Date(), updatedAt: new Date(), value: "1" };
    const gone = new Date(Date.now() - 1000);
    w.local.data.verification.push(
      { ...old, id: "stale", identifier: "dozo-hosted-login:stale", expiresAt: gone },
      { ...old, id: "other", identifier: "reset-password:x", expiresAt: gone },
    );
    await w.start();
    const ids = w.local.data.verification.map((row) => row.id);
    expect(ids).not.toContain("stale");
    expect(ids).toContain("other");
    expect(ids).toHaveLength(2);
  });

  it("refuses a callback without a token, and a forged one", async () => {
    const w = world();
    const started = await w.start();
    expect(location(await w.get(w.local.auth, CALLBACK, started.cookie))).toBe(FAILED);
    const forged = signLoginToken(ed25519(), {
      ...claims,
      aud: started.page.searchParams.get("audience")!,
    });
    expect(location(await w.get(w.local.auth, `${CALLBACK}?token=${forged}`, started.cookie))).toBe(
      FAILED,
    );
  });

  it("refuses when the issuer's keys cannot be fetched", async () => {
    const local = localServer(vi.fn(async () => new Response("", { status: 500 })) as never);
    const start = await local.auth.handler(startRequest());
    const { url } = (await start.json()) as { url: string };
    const nonce = new URL(url).searchParams.get("audience")!;
    const token = signLoginToken(ed25519(), { ...claims, aud: nonce });
    const done = await local.auth.handler(
      new Request(`${CALLBACK}?token=${token}`, { headers: { cookie: cookieHeader(start) } }),
    );
    expect(location(done)).toBe(FAILED);
  });

  it("closes every other way in on the local server", async () => {
    const w = world();
    for (const path of [
      "/sign-up/email",
      "/sign-in/email",
      "/sign-in/social",
      "/request-password-reset",
      "/send-verification-email",
      "/change-password",
    ]) {
      const response = await w.local.auth.handler(
        new Request(`${LOCAL}/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: LOCAL },
          body: JSON.stringify({
            email: "ada@dozo.example",
            password: "a-long-enough-password",
            newPassword: "another-long-password",
            currentPassword: "a-long-enough-password",
            name: "A",
            provider: "google",
          }),
        }),
      );
      expect(response.status, path).toBe(404);
    }
    expect(w.local.data.user).toEqual([]);
  });

  it("limits starting and finishing a sign-in each on its own count", async () => {
    const local = localServer(vi.fn() as never, { rateLimit: true });
    const from = { "x-forwarded-for": "203.0.113.9" };
    const statuses = async (count: number, request: () => Request) => {
      const seen: number[] = [];
      for (let i = 0; i < count; i++) seen.push((await local.auth.handler(request())).status);
      return seen;
    };
    const starts = await statuses(11, () => startRequest({ origin: LOCAL, ...from }));
    expect(starts.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(starts[10]).toBe(429);
    // A page elsewhere spending the callback's count does not reach starting, and needs 60.
    const callbacks = await statuses(
      61,
      () => new Request(`${CALLBACK}?token=x`, { headers: from }),
    );
    expect(callbacks.slice(0, 60).every((status) => status === 302)).toBe(true);
    expect(callbacks[60]).toBe(429);
    expect(local.data.rateLimit.length).toBeGreaterThan(0);
  });
});

describe("the hosted server", () => {
  const body = { audience: AUDIENCE, return: CALLBACK };

  it("signs its web origin as the issuer, also when its API answers on another", async () => {
    const { auth } = hostedServer(ed25519(), false, "https://api.dozo.example");
    const cookie = await auth.handler(
      new Request("https://api.dozo.example/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: HOSTED },
        body: JSON.stringify({
          email: "a@dozo.example",
          name: "A",
          password: "a-long-enough-password",
        }),
      }),
    );
    const response = await auth.handler(
      new Request("https://api.dozo.example/api/auth/dozo/hosted-login/issue", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: HOSTED,
          cookie: cookieHeader(cookie),
        },
        body: JSON.stringify(body),
      }),
    );
    const { url } = (await response.json()) as { url: string };
    expect(payloadOf(url).iss).toBe(HOSTED);
  });

  it("publishes its public key", async () => {
    const key = ed25519();
    const { auth } = hostedServer(key);
    const response = await auth.handler(new Request(`${HOSTED}/api/auth/dozo/hosted-login/keys`));
    expect(await response.json()).toEqual({ keys: [publicJwk(key)] });
    expect(response.headers.get("cache-control")).toMatch(/max-age=300/);
  });

  it("issues nothing without a session", async () => {
    const { auth } = hostedServer(ed25519());
    const response = await auth.handler(issueRequest(body, { origin: HOSTED }));
    expect(response.status).toBe(401);
  });

  it("issues nothing to a request from another site, or to a link that is only opened", async () => {
    const { auth } = hostedServer(ed25519());
    const cookie = await signUp(auth, "ada@dozo.example", "Ada");
    const refused: Record<string, string>[] = [
      { cookie, origin: "https://evil.example" },
      { cookie, origin: "null" },
      { cookie },
    ];
    for (const headers of refused) {
      const response = await auth.handler(issueRequest(body, headers));
      expect(response.status).toBe(403);
    }
    const url = new URL(`${HOSTED}/api/auth/dozo/hosted-login/issue`);
    url.searchParams.set("audience", AUDIENCE);
    url.searchParams.set("return", CALLBACK);
    const opened = await auth.handler(new Request(url, { headers: { cookie } }));
    expect(opened.status).not.toBe(200);
    expect(location(opened)).toBeNull();
  });

  it("answers only with the loopback callback", async () => {
    const { auth } = hostedServer(ed25519());
    const cookie = await signUp(auth, "ada@dozo.example", "Ada");
    for (const [audience, back] of [
      [AUDIENCE, "https://evil.example/api/auth/dozo/hosted-login/callback"],
      [AUDIENCE, ""],
      ["short", CALLBACK],
      ["", CALLBACK],
    ] as const) {
      const response = await auth.handler(
        issueRequest({ audience, return: back }, { cookie, origin: HOSTED }),
      );
      expect(response.status).toBe(400);
    }
  });

  it("limits how often one address may ask for a token", async () => {
    const { auth, data } = hostedServer(ed25519(), true);
    const cookie = await signUp(auth, "ada@dozo.example", "Ada");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push(
        (
          await auth.handler(
            issueRequest(body, { cookie, origin: HOSTED, "x-forwarded-for": "203.0.113.9" }),
          )
        ).status,
      );
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(data.rateLimit.length).toBeGreaterThan(0);
  });
});
