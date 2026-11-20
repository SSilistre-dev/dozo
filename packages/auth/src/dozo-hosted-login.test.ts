import type { KeyObject } from "node:crypto";
import { generateKeyPairSync, sign } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostedLoginClaims, HostedLoginConfig } from "./dozo-hosted-login.js";
import {
  CLOCK_LEEWAY_SECONDS,
  dozoHostedLogin,
  HOSTED_PROVIDER_ID,
  HostedLoginError,
  hostedLoginConfig,
  hostedPlanOf,
  issuerKeys,
  issuerOrigin,
  KEY_REFRESH_SECONDS,
  loopbackCallback,
  publicJwk,
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
  plan: "standard",
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
    expect(dozoHostedLogin({ webOrigin: LOCAL, planOf: vi.fn(), config: null })).toEqual([]);
    expect(dozoHostedLogin({ webOrigin: LOCAL, planOf: vi.fn() })).toEqual([]);
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
    ["no plan", { plan: undefined }, "claims"],
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

  it("fails when the issuer does not answer with keys", async () => {
    await expect(issuerKeys(HOSTED, answer({}, 503) as typeof fetch)("k", NOW)).rejects.toThrow(
      /HTTP 503/,
    );
    expect(await issuerKeys(HOSTED, answer({ keys: "no" }) as typeof fetch)("k", NOW)).toBeNull();
  });
});

describe("the plan in the token", () => {
  const prisma = (memberships: { organizationId: string; role: string }[], organization: unknown) =>
    ({
      member: { findMany: vi.fn(async () => memberships) },
      organization: { findUnique: vi.fn(async () => organization) },
    }) as never;

  it("is the tier in force on the user's own organization", async () => {
    const live = { billing: { status: "active", byokTier: "pro" }, dozoPlanGrant: null };
    expect(await hostedPlanOf(prisma([{ organizationId: "o", role: "owner" }], live), "u")).toBe(
      "pro",
    );
    const ended = { billing: { status: "canceled", byokTier: "max" }, dozoPlanGrant: null };
    expect(await hostedPlanOf(prisma([{ organizationId: "o", role: "owner" }], ended), "u")).toBe(
      "standard",
    );
  });

  it("is Free for a user who owns no organization", async () => {
    expect(await hostedPlanOf(prisma([{ organizationId: "o", role: "member" }], null), "u")).toBe(
      "standard",
    );
  });

  it("passes other failures on", async () => {
    const failing = {
      member: { findMany: vi.fn(async () => Promise.reject(new Error("db down"))) },
      organization: { findUnique: vi.fn() },
    } as never;
    await expect(hostedPlanOf(failing, "u")).rejects.toThrow("db down");
  });
});

type Row = Record<string, unknown>;
type Store = { user: Row[]; session: Row[]; account: Row[]; verification: Row[] };
type Handler = { handler: (request: Request) => Promise<Response> };
const store = (): Store => ({ user: [], session: [], account: [], verification: [] });

function hostedServer(key: KeyObject, rateLimit = false) {
  const data = store();
  const planOf = vi.fn(async () => "pro");
  const auth = betterAuth({
    secret: SECRET,
    baseURL: HOSTED,
    database: memoryAdapter(data),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: rateLimit, storage: "memory" },
    plugins: dozoHostedLogin({
      webOrigin: HOSTED,
      planOf,
      config: { mode: "issuer", signingKey: key },
    }),
  });
  return { auth, data, planOf };
}

function localServer(fetcher: typeof fetch, refuse?: (userId: string) => boolean) {
  const data = store();
  const config: HostedLoginConfig = { mode: "verifier", issuer: HOSTED };
  const auth = betterAuth({
    secret: SECRET,
    baseURL: LOCAL,
    database: memoryAdapter(data),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            if (refuse?.(session.userId))
              throw new APIError("FORBIDDEN", { code: "REGISTRATION_CLOSED" });
          },
        },
      },
    },
    plugins: dozoHostedLogin({ webOrigin: LOCAL, planOf: vi.fn(), config, fetcher }),
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

/** The two servers, the browser's cookies for each, and one full sign-in. */
function world(options: { refuse?: (userId: string) => boolean } = {}) {
  const key = ed25519();
  const hosted = hostedServer(key);
  const fetcher = vi.fn(async (input: string | URL | Request) =>
    hosted.auth.handler(new Request(String(input))),
  ) as unknown as typeof fetch;
  const local = localServer(fetcher, options.refuse);
  const get = (auth: Handler, url: string, cookie = "") =>
    auth.handler(new Request(url, { headers: cookie ? { cookie } : {} }));

  async function start() {
    const response = await get(local.auth, `${LOCAL}/api/auth/dozo/hosted-login/start`);
    expect(response.status).toBe(302);
    return { issue: new URL(response.headers.get("location")!), cookie: cookieHeader(response) };
  }

  async function issue(url: URL, hostedCookie: string) {
    const response = await get(hosted.auth, url.href, hostedCookie);
    return response;
  }

  async function signIn(hostedCookie: string) {
    const started = await start();
    const issued = await issue(started.issue, hostedCookie);
    expect(issued.status).toBe(302);
    const callback = issued.headers.get("location")!;
    const done = await get(local.auth, callback, started.cookie);
    return { started, callback, done };
  }

  return { key, hosted, local, fetcher, get, start, issue, signIn };
}

const location = (response: Response) => response.headers.get("location");
const FAILED = `${LOCAL}/sign-in?error=hosted_login_failed`;

describe("signing in to a local server with the hosted account", () => {
  it("creates the local user from the hosted account and opens a session", async () => {
    const w = world();
    const hostedCookie = await signUp(w.hosted.auth, "Ada@Dozo.example", "Ada");
    const { started, callback, done } = await w.signIn(hostedCookie);

    expect(started.issue.origin).toBe(HOSTED);
    expect(started.issue.pathname).toBe("/api/auth/dozo/hosted-login/issue");
    expect(started.issue.searchParams.get("return")).toBe(CALLBACK);
    expect(started.cookie).toMatch(/dozo_hosted_login=/);
    expect(callback.startsWith(`${CALLBACK}?token=`)).toBe(true);
    expect(done.status).toBe(302);
    expect(location(done)).toBe(`${LOCAL}/`);
    expect(done.headers.get("cache-control")).toBe("no-store");

    const [user] = w.local.data.user;
    expect(user).toMatchObject({ email: "ada@dozo.example", name: "Ada", emailVerified: false });
    const hostedUser = w.hosted.data.user[0]!;
    expect(w.local.data.account).toEqual([
      expect.objectContaining({
        providerId: HOSTED_PROVIDER_ID,
        accountId: hostedUser.id,
        userId: user!.id,
      }),
    ]);
    expect(w.hosted.planOf).toHaveBeenCalledWith(hostedUser.id);

    const session = await w.local.auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader(done) }),
    });
    expect(session?.user.id).toBe(user!.id);
    // The nonce is spent.
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
    w.local.data.user.push({
      id: "other",
      email: "taken@dozo.example",
      name: "Other",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
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

  it("does not take over a local account that only shares the address", async () => {
    const w = world();
    w.local.data.user.push({
      id: "local",
      email: "ada@dozo.example",
      name: "Local",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { done } = await w.signIn(await signUp(w.hosted.auth, "ada@dozo.example", "Ada"));
    expect(location(done)).toBe(FAILED);
    expect(w.local.data.account).toEqual([]);
  });

  it("removes the user it created when the session is refused", async () => {
    const w = world({ refuse: () => true });
    const { done } = await w.signIn(await signUp(w.hosted.auth, "ada@dozo.example", "Ada"));
    expect(location(done)).toBe(FAILED);
    expect(w.local.data.user).toEqual([]);
    expect(w.local.data.account).toEqual([]);
  });

  it("refuses a token used twice", async () => {
    const w = world();
    const { started, callback } = await w.signIn(
      await signUp(w.hosted.auth, "ada@dozo.example", "Ada"),
    );
    const again = await w.get(w.local.auth, callback, started.cookie);
    expect(location(again)).toBe(FAILED);
  });

  it("refuses a token in a browser that did not start the sign-in", async () => {
    const w = world();
    const hostedCookie = await signUp(w.hosted.auth, "ada@dozo.example", "Ada");
    const started = await w.start();
    const callback = location(await w.issue(started.issue, hostedCookie))!;
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
    const callback = location(await w.issue(started.issue, hostedCookie))!;
    for (const row of w.local.data.verification) row.expiresAt = new Date(Date.now() - 1000);
    expect(location(await w.get(w.local.auth, callback, started.cookie))).toBe(FAILED);
  });

  it("refuses a callback without a token, and a forged one", async () => {
    const w = world();
    const started = await w.start();
    expect(location(await w.get(w.local.auth, CALLBACK, started.cookie))).toBe(FAILED);
    const forged = signLoginToken(ed25519(), {
      ...claims,
      aud: started.issue.searchParams.get("audience")!,
    });
    expect(location(await w.get(w.local.auth, `${CALLBACK}?token=${forged}`, started.cookie))).toBe(
      FAILED,
    );
  });

  it("refuses when the issuer's keys cannot be fetched", async () => {
    const local = localServer(vi.fn(async () => new Response("", { status: 500 })) as never);
    const start = await local.auth.handler(
      new Request(`${LOCAL}/api/auth/dozo/hosted-login/start`),
    );
    const nonce = new URL(location(start)!).searchParams.get("audience")!;
    const token = signLoginToken(ed25519(), { ...claims, aud: nonce });
    const done = await local.auth.handler(
      new Request(`${CALLBACK}?token=${token}`, { headers: { cookie: cookieHeader(start) } }),
    );
    expect(location(done)).toBe(FAILED);
  });

  it("closes password and emailed-code sign-in on the local server", async () => {
    const w = world();
    for (const path of ["/sign-up/email", "/sign-in/email", "/request-password-reset"]) {
      const response = await w.local.auth.handler(
        new Request(`${LOCAL}/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: LOCAL },
          body: JSON.stringify({
            email: "ada@dozo.example",
            password: "a-long-enough-password",
            name: "A",
          }),
        }),
      );
      expect(response.status).toBe(404);
    }
    expect(w.local.data.user).toEqual([]);
  });
});

describe("the hosted server", () => {
  it("publishes its public key", async () => {
    const key = ed25519();
    const { auth } = hostedServer(key);
    const response = await auth.handler(new Request(`${HOSTED}/api/auth/dozo/hosted-login/keys`));
    expect(await response.json()).toEqual({ keys: [publicJwk(key)] });
    expect(response.headers.get("cache-control")).toMatch(/max-age=300/);
  });

  it("sends a signed-out user to sign in, and issues nothing", async () => {
    const { auth, planOf } = hostedServer(ed25519());
    const url = new URL(`${HOSTED}/api/auth/dozo/hosted-login/issue`);
    url.searchParams.set("audience", AUDIENCE);
    url.searchParams.set("return", CALLBACK);
    const response = await auth.handler(new Request(url));
    expect(response.status).toBe(302);
    expect(location(response)).toBe(`${HOSTED}/sign-in`);
    expect(planOf).not.toHaveBeenCalled();
  });

  it("never redirects to an address the request names unless it is the loopback callback", async () => {
    const { auth } = hostedServer(ed25519());
    const cookie = await signUp(auth, "ada@dozo.example", "Ada");
    for (const [audience, back] of [
      [AUDIENCE, "https://evil.example/api/auth/dozo/hosted-login/callback"],
      [AUDIENCE, ""],
      ["short", CALLBACK],
      ["", CALLBACK],
    ] as const) {
      const url = new URL(`${HOSTED}/api/auth/dozo/hosted-login/issue`);
      url.searchParams.set("audience", audience);
      url.searchParams.set("return", back);
      const response = await auth.handler(new Request(url, { headers: { cookie } }));
      expect(response.status).toBe(400);
      expect(location(response)).toBeNull();
    }
  });

  it("limits how often the sign-in endpoints answer one address", async () => {
    const { auth } = hostedServer(ed25519(), true);
    const ask = () =>
      auth.handler(
        new Request(`${HOSTED}/api/auth/dozo/hosted-login/keys`, {
          headers: { "x-forwarded-for": "203.0.113.9" },
        }),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await ask()).status);
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
