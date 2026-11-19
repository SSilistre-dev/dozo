import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { createAuth } from "./index.js";

// Better Auth's real routes over its offline memory adapter, as the ban list tests do.
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@rakazo/db", async () => {
  const { signupPolicyFromEnv } = await import("@rakazo/core");
  return {
    siteSignupPolicy: vi.fn(async (_db: unknown, env: Parameters<typeof signupPolicyFromEnv>[0]) =>
      signupPolicyFromEnv(env),
    ),
    bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })),
    leaveInvitedSpaces: vi.fn(async () => ({ ownedOrganizationIds: [] })),
    recordSecurityEvent: vi.fn(async () => undefined),
  };
});

const baseURL = "http://auth.example.test";
const webOrigin = "http://web.example.test";
const email = "ada@example.test";
const password = "offline-password-1234";

function fixture({ origin = baseURL, web = webOrigin } = {}) {
  const messages: TransactionalEmail[] = [];
  const devices = vi.fn(async () => ({ count: 0 }));
  const prisma = {
    authData: { user: [], account: [], session: [], verification: [] },
    // The verification mail limit lets every mail go; the ban list is empty.
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) =>
      sql.join("").includes("rateLimit") ? [{ count: 1 }] : [],
    ),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        signupsEnabled: true,
        signupAllowlist: "",
        signupPolicyInitialized: true,
      })),
    },
    spaceMember: { findFirst: vi.fn(async () => ({ spaceId: "space-1" })) },
    user: { findUnique: vi.fn(async () => null) },
    passkey: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    account: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    messagingLinkCode: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    userDevice: { updateMany: devices },
  };
  const auth = createAuth(prisma as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL: origin,
    webOrigin: web,
    signupsEnabled: "true",
    signupAllowlist: "",
    email: {
      describe: () => ({
        id: "offline-email",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { transactional: true },
      }),
      send: async (message) => {
        messages.push(message);
      },
    },
  });
  const call = (path: string, body?: unknown, cookie?: string) =>
    auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          origin: web,
          ...(cookie ? { cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const cookieOf = (response: Response, jar = "") => {
    const cookies = new Map(
      jar
        .split("; ")
        .filter(Boolean)
        .map((pair) => [pair.split("=")[0], pair] as const),
    );
    for (const set of response.headers.getSetCookie?.() ?? []) {
      const pair = set.split(";")[0] as string;
      const name = pair.split("=")[0] as string;
      if (/max-age=0/i.test(set) || pair.endsWith("=")) cookies.delete(name);
      else cookies.set(name, pair);
    }
    return [...cookies.values()].join("; ");
  };
  const signUp = async (address = email, cookie?: string) => {
    const response = await call(
      "/sign-up/email",
      { email: address, password, name: "Ada" },
      cookie,
    );
    expect(response.status).toBe(200);
    return cookieOf(response);
  };
  const signIn = (cookie?: string) => call("/sign-in/email", { email, password }, cookie);
  /** Opens the link of the last verification mail, in a browser holding `cookie` or none. */
  const openLink = async (cookie?: string, edit = (_url: URL) => {}) => {
    // The mail goes out in the background.
    const mail = await vi.waitFor(() => {
      const found = messages.findLast((message) => message.text.includes("/verify-email?"));
      if (!found) throw new Error("no verification mail yet");
      return found;
    });
    const url = new URL(mail.text.match(/https?:\/\/\S+/)![0]);
    edit(url);
    return call(`${url.pathname.replace("/api/auth", "")}${url.search}`, undefined, cookie);
  };
  const user = async (cookie: string) =>
    (await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user ?? null;
  return { prisma, messages, devices, call, cookieOf, signUp, signIn, openLink, user };
}

describe("the emailed verification link", () => {
  it("opened where the account is not signed in, verifies nothing and takes nothing away", async () => {
    const f = fixture();
    const earlier = await f.signUp();

    const opened = await f.openLink();

    expect(opened.status).toBe(302);
    // The link's result page, which asks this browser to sign in.
    expect(opened.headers.get("location")).toMatch(
      new RegExp(`^${webOrigin}/verify-email\\?v=[^&]+$`),
    );
    expect(await f.user(earlier)).toMatchObject({ email, emailVerified: false });
    expect((await f.signIn()).status).toBe(200);
    expect(f.devices).not.toHaveBeenCalled();
  });

  it("finishes once that browser signs in to the account", async () => {
    const f = fixture();
    const earlier = await f.signUp();
    const browser = f.cookieOf(await f.openLink());

    const signedIn = await f.signIn(browser);

    expect(signedIn.status).toBe(200);
    const after = f.cookieOf(signedIn, browser);
    expect(await f.user(after)).toMatchObject({ email, emailVerified: true });
    // The account kept its first session, and the browser keeps nothing of the link.
    expect(await f.user(earlier)).toMatchObject({ emailVerified: true });
    expect(after).not.toMatch(/verify/);
  });

  it("is not finished by a sign-in in another browser", async () => {
    const f = fixture();
    const session = await f.signUp();
    await f.openLink();

    expect((await f.signIn()).status).toBe(200);

    expect(await f.user(session)).toMatchObject({ emailVerified: false });
  });

  it("opened where the account is signed in, verifies it and keeps everything", async () => {
    const f = fixture();
    const session = await f.signUp();

    expect((await f.openLink(session)).status).toBeLessThan(400);

    expect(await f.user(session)).toMatchObject({ email, emailVerified: true });
    expect((await f.signIn()).status).toBe(200);
    expect(f.devices).not.toHaveBeenCalled();
  });

  it("opened again once the address is verified, changes nothing", async () => {
    const f = fixture();
    const session = await f.signUp();
    await f.openLink(session);

    expect((await f.openLink()).status).toBeLessThan(400);

    expect(await f.user(session)).toMatchObject({ emailVerified: true });
    expect((await f.signIn()).status).toBe(200);
  });

  it("opened without a page to return to, answers that signing in is needed", async () => {
    const f = fixture();
    const earlier = await f.signUp();

    const opened = await f.openLink(undefined, (url) => url.searchParams.delete("callbackURL"));

    expect(opened.status).toBe(403);
    expect(await f.user(earlier)).toMatchObject({ emailVerified: false });
  });

  it("holds the link only over https where the server is served over https", async () => {
    const f = fixture({ origin: "https://auth.example.test", web: "https://web.example.test" });
    await f.signUp();

    const opened = await f.openLink();

    expect(opened.headers.get("set-cookie")).toMatch(/dozo_pending_verification=.*; Secure/);
  });

  it("is not finished by that browser signing in to another account", async () => {
    const f = fixture();
    const ada = await f.signUp();
    const browser = f.cookieOf(await f.openLink());

    const other = await f.signUp("bob@example.test", browser);

    expect(await f.user(other)).toMatchObject({ emailVerified: false });
    expect(await f.user(ada)).toMatchObject({ emailVerified: false });
  });

  it("is not finished by a held link that does not check out", async () => {
    const f = fixture();
    const session = await f.signUp();
    const browser = f
      .cookieOf(await f.openLink())
      .replace(/dozo_pending_verification=[^;]+/, "dozo_pending_verification=not-a-link");

    expect((await f.signIn(browser)).status).toBe(200);

    expect(await f.user(session)).toMatchObject({ emailVerified: false });
  });
});
