import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { signJWT } from "better-auth/crypto";
import { describe, expect, it, vi } from "vitest";
import { banEntry } from "./dozo-operator.js";
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
const otherPassword = "another-password-5678";

type FixtureOptions = { origin?: string; web?: string; allowlist?: string; signups?: string };

function fixture({
  origin = baseURL,
  web = webOrigin,
  allowlist = "",
  signups = "true",
}: FixtureOptions = {}) {
  const messages: TransactionalEmail[] = [];
  const devices = vi.fn(async () => ({ count: 0 }));
  const banned = new Set<string>();
  const mailCounts = new Map<string, number>();
  const prisma = {
    authData: { user: [] as Record<string, unknown>[], account: [], session: [], verification: [] },
    // The verification mail limit counts per address like the real one; the ban list reads `banned`.
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      if (sql.join("").includes("rateLimit")) {
        const key = String(values[1]);
        mailCounts.set(key, (mailCounts.get(key) ?? 0) + 1);
        return [{ count: mailCounts.get(key) }];
      }
      return Array.isArray(values[0])
        ? (values[0] as string[]).filter((key) => banned.has(key)).map((value) => ({ value }))
        : [];
    }),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        signupsEnabled: signups === "true",
        signupAllowlist: allowlist,
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
  /** The server with a mail provider, and the same data served as before one was configured. */
  const serve = (withMail: boolean) => {
    const auth = createAuth(prisma as never, {
      secret: "offline-auth-secret-at-least-32-characters",
      baseURL: origin,
      webOrigin: web,
      signupsEnabled: signups,
      signupAllowlist: allowlist,
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
    for (const set of response.headers.getSetCookie?.() ?? []) {
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
      if (!found) throw new Error("no verification mail yet");
      return found;
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
  /** A new account, verified the way the page does it: the link, then the password, in one browser. */
  const verifiedAccount = async (address: string) => {
    await signUp(address);
    const browser = cookieOf(await openLink(undefined, undefined, address));
    expect((await signIn(browser, password, address)).status).toBe(200);
    expect(stored(address)).toMatchObject({ emailVerified: true });
  };
  return {
    prisma,
    messages,
    devices,
    banned,
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
  };
}

describe("the emailed verification link", () => {
  it("opened where the account is not signed in, verifies nothing and takes nothing away", async () => {
    const f = fixture();
    const earlier = await f.oldAccount();

    const opened = await f.openLink();

    expect(opened.status).toBe(302);
    // The link's result page, which asks this browser to sign in.
    expect(opened.headers.get("location")).toMatch(
      new RegExp(`^${webOrigin}/verify-email\\?v=[^&]+$`),
    );
    expect(await f.user(earlier)).toMatchObject({ email, emailVerified: false });
    // Was a sign-in at once; a password alone no longer signs in an unverified address.
    expect((await f.signIn()).status).toBe(403);
    expect(f.devices).not.toHaveBeenCalled();
  });

  it("finishes once that browser signs in to the account", async () => {
    const f = fixture();
    const earlier = await f.oldAccount();
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
    const session = await f.oldAccount();
    await f.openLink();

    // Was 200; this browser holds no link, so the password alone is refused.
    expect((await f.signIn()).status).toBe(403);

    expect(await f.user(session)).toMatchObject({ emailVerified: false });
  });

  it("opened where the account is signed in, verifies it and keeps everything", async () => {
    const f = fixture();
    const session = await f.oldAccount();

    expect((await f.openLink(session)).status).toBeLessThan(400);

    expect(await f.user(session)).toMatchObject({ email, emailVerified: true });
    expect((await f.signIn()).status).toBe(200);
    expect(f.devices).not.toHaveBeenCalled();
  });

  it("opened again once the address is verified, changes nothing", async () => {
    const f = fixture();
    const session = await f.oldAccount();
    await f.openLink(session);

    expect((await f.openLink()).status).toBeLessThan(400);

    expect(await f.user(session)).toMatchObject({ emailVerified: true });
    expect((await f.signIn()).status).toBe(200);
  });

  it("opened without a page to return to, answers that signing in is needed", async () => {
    const f = fixture();
    const earlier = await f.oldAccount();

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
    const ada = await f.oldAccount();
    const browser = f.cookieOf(await f.openLink());

    // Bob's account predates the mail provider, so signing up opens his session.
    const other = await f.signUp("bob@example.test", browser, f.legacy);

    expect(await f.user(other)).toMatchObject({ emailVerified: false });
    expect(await f.user(ada)).toMatchObject({ emailVerified: false });
  });

  it("is not finished by a held link that does not check out", async () => {
    const f = fixture();
    const session = await f.oldAccount();
    const browser = f
      .cookieOf(await f.openLink())
      .replace(/dozo_pending_verification=[^;]+/, "dozo_pending_verification=not-a-link");

    // Was 200; a link that does not check out proves nothing, so the password alone is refused.
    expect((await f.signIn(browser)).status).toBe(403);

    expect(await f.user(session)).toMatchObject({ emailVerified: false });
  });
});

describe("a password sign-up where a mail provider is configured", () => {
  const sessionCookie = /session_token/;

  it("gives no session, and sends the verification mail", async () => {
    const f = fixture();

    const response = await f.register();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: null, user: { email } });
    expect(response.headers.getSetCookie?.() ?? []).toEqual([]);
    expect(await f.user("")).toBeNull();
    expect(f.stored()).toMatchObject({ email, emailVerified: false });
    await vi.waitFor(() => expect(f.mailsTo(email)).toHaveLength(1));
  });

  it("asks an unverified account with the right password for verification, and mails a new link", async () => {
    const f = fixture();
    await f.signUp();
    await vi.waitFor(() => expect(f.mailsTo(email)).toHaveLength(1));

    const refused = await f.signIn();

    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(refused.headers.getSetCookie?.().join()).not.toMatch(sessionCookie);
    await vi.waitFor(() => expect(f.mailsTo(email)).toHaveLength(2));
  });

  it("sends at most three verification mails an hour to one address", async () => {
    const f = fixture();
    await f.signUp();
    for (let attempt = 0; attempt < 4; attempt++) expect((await f.signIn()).status).toBe(403);

    await vi.waitFor(() => expect(f.mailsTo(email)).toHaveLength(3));
  });

  it("refuses a wrong password and an unknown address with the one answer", async () => {
    const f = fixture();
    await f.signUp();
    await f.verifiedAccount("grace@example.test");
    const answers = [
      await f.signIn(undefined, otherPassword, "nobody@example.test"),
      await f.signIn(undefined, password, "nobody@example.test"),
      await f.signIn(undefined, otherPassword, email),
      await f.signIn(undefined, otherPassword, "grace@example.test"),
    ];

    for (const answer of answers) {
      expect(answer.status).toBe(401);
      expect(answer.headers.getSetCookie?.().join()).not.toMatch(sessionCookie);
    }
    const bodies = await Promise.all(answers.map((answer) => answer.json()));
    for (const body of bodies) expect(body).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });

  it("answers a second sign-up for any address in the same shape, with no session and no change", async () => {
    const f = fixture();
    await f.verifiedAccount("grace@example.test");
    await f.signUp();
    const accounts = f.prisma.authData.user.length;

    const answers = [
      await f.register(email, undefined, undefined, otherPassword),
      await f.register("grace@example.test", undefined, undefined, otherPassword),
      await f.register("new@example.test"),
    ];

    const bodies = await Promise.all(answers.map((answer) => answer.json()));
    for (const [index, answer] of answers.entries()) {
      expect(answer.status).toBe(200);
      expect(bodies[index]).toMatchObject({ token: null });
      // The memory adapter leaves out the empty `image` and `deactivatedAt` of a stored account
      // that the answer for an existing address carries, which a database row would also hold; so
      // the two existing-address answers are compared whole and the new one by its stored fields.
      expect(Object.keys(bodies[index].user)).toEqual(
        expect.arrayContaining(Object.keys(bodies[2].user)),
      );
      expect(answer.headers.getSetCookie?.() ?? []).toEqual([]);
    }
    expect(Object.keys(bodies[0].user)).toEqual(Object.keys(bodies[1].user));
    // Only the new address made an account, and nobody's password changed.
    expect(f.prisma.authData.user).toHaveLength(accounts + 1);
    expect((await f.signIn(undefined, otherPassword)).status).toBe(401);
    const browser = f.cookieOf(await f.openLink());
    expect((await f.signIn(browser)).status).toBe(200);
    expect((await f.signIn(undefined, otherPassword, "grace@example.test")).status).toBe(401);
  });

  it("is finished by the browser that opened the link, with the account's password", async () => {
    const f = fixture();
    await f.signUp();
    const opened = await f.openLink();
    expect(opened.status).toBe(302);
    expect(f.stored()).toMatchObject({ emailVerified: false });
    const browser = f.cookieOf(opened);

    const signedIn = await f.signIn(browser);

    expect(signedIn.status).toBe(200);
    const session = f.cookieOf(signedIn, browser);
    expect(await f.user(session)).toMatchObject({ email, emailVerified: true });
    expect(session).not.toMatch(/verify/);
    // The password stays: a later sign-in without the link works.
    expect((await f.signIn()).status).toBe(200);
  });

  it("is not finished by that browser with a wrong password", async () => {
    const f = fixture();
    await f.signUp();
    const browser = f.cookieOf(await f.openLink());

    expect((await f.signIn(browser, otherPassword)).status).toBe(401);

    expect(f.stored()).toMatchObject({ emailVerified: false });
  });

  it("is not finished by the right password without the link", async () => {
    const f = fixture();
    await f.signUp();
    await f.openLink();

    expect((await f.signIn()).status).toBe(403);

    expect(f.stored()).toMatchObject({ emailVerified: false });
  });

  it("is not finished by another account's link with this account's password", async () => {
    const f = fixture();
    await f.signUp();
    await f.signUp("bob@example.test");
    const bobsBrowser = f.cookieOf(await f.openLink(undefined, undefined, "bob@example.test"));

    expect((await f.signIn(bobsBrowser)).status).toBe(403);

    expect(f.stored()).toMatchObject({ emailVerified: false });
    expect(f.stored("bob@example.test")).toMatchObject({ emailVerified: false });
  });

  it("is not finished by a link that changes the address", async () => {
    const f = fixture();
    await f.signUp();
    const link = await signJWT(
      { email, updateTo: "new@example.test" },
      "offline-auth-secret-at-least-32-characters",
      3600,
    );

    const attempt = await f.signIn(`dozo_pending_verification=${link}`);

    expect(attempt.status).toBe(403);
    expect(f.stored()).toMatchObject({ emailVerified: false });
  });

  it("is not finished by a link when the body does not name an address and a password", async () => {
    const f = fixture();
    await f.signUp();
    const browser = f.cookieOf(await f.openLink());

    const attempt = await f.call("/sign-in/email", { email: [email], password: 1 }, browser);

    expect(attempt.status).toBeLessThan(500);
    expect(attempt.status).not.toBe(200);
    expect(f.stored()).toMatchObject({ emailVerified: false });
  });
});

describe("a sign-in code on an account that never proved its address", () => {
  const codeOf = async (f: ReturnType<typeof fixture>, address: string) => {
    expect(
      (await f.call("/email-otp/send-verification-otp", { email: address, type: "sign-in" }))
        .status,
    ).toBe(200);
    const mail = await vi.waitFor(() => {
      const found = f.messages.findLast(
        (m) => m.to === address && !m.text.includes("/verify-email?"),
      );
      if (!found) throw new Error("no code yet");
      return found;
    });
    return mail.text.match(/\b(\d{6})\b/)![1];
  };

  it("signs in and verifies the address, and the password stops working", async () => {
    const f = fixture();
    await f.signUp();
    const otp = await codeOf(f, email);

    const signedIn = await f.call("/sign-in/email-otp", { email, otp });

    expect(signedIn.status).toBe(200);
    const session = f.cookieOf(signedIn);
    expect(await f.user(session)).toMatchObject({ email, emailVerified: true });
    // Better Auth removes the unproven account's logins; the fork removes what it stores elsewhere.
    expect((await f.signIn()).status).toBe(401);
    expect(f.prisma.passkey.deleteMany).toHaveBeenCalled();
    expect(f.prisma.account.deleteMany).toHaveBeenCalled();
    expect(f.prisma.messagingIdentity.deleteMany).toHaveBeenCalled();
    expect(f.prisma.messagingLinkCode.deleteMany).toHaveBeenCalled();
    expect(f.devices).toHaveBeenCalled();
  });

  it("opens a new, verified account with a session", async () => {
    const f = fixture();
    const address = "new@example.test";
    const otp = await codeOf(f, address);

    const signedIn = await f.call("/sign-in/email-otp", { email: address, otp });

    expect(signedIn.status).toBe(200);
    expect(await f.user(f.cookieOf(signedIn))).toMatchObject({
      email: address,
      emailVerified: true,
    });
  });
});

describe("where no mail provider is configured", () => {
  it("opens a session at sign-up, signs in an unverified account, and refuses a second sign-up", async () => {
    const f = fixture();
    const session = await f.signUp(email, undefined, f.legacy);
    expect(await f.user(session)).toMatchObject({ email, emailVerified: false });

    const signedIn = await f.legacy.call("/sign-in/email", { email, password });
    expect(signedIn.status).toBe(200);

    const again = await f.register(email, undefined, f.legacy);
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });
  });
});

describe("the sign-up policy where a mail provider is configured", () => {
  it("refuses an address off the list, and signs a listed one up without a session", async () => {
    const f = fixture({ allowlist: "@example.test" });

    const off = await f.register("eve@elsewhere.test");
    const listed = await f.register();

    expect(off.status).toBe(400);
    expect(await off.json()).toMatchObject({ code: "EMAIL_NOT_ALLOWED" });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ token: null });
    expect(listed.headers.getSetCookie?.() ?? []).toEqual([]);
  });

  it("refuses everyone while registration is closed", async () => {
    const f = fixture({ signups: "false" });

    const response = await f.register();

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "REGISTRATION_CLOSED" });
    expect(f.prisma.authData.user).toEqual([]);
  });

  it("makes no account for a banned address, and answers as for any other", async () => {
    const f = fixture();
    f.banned.add(banEntry("eve@example.test") as string);

    const banned = await f.register("eve@example.test");
    const other = await f.register("adam@example.test");

    // The ban refuses with 403, which Better Auth turns into its generic answer while a
    // mailbox is required: a banned address cannot be told from any other, on purpose.
    expect(banned.status).toBe(200);
    expect(await banned.json()).toMatchObject({ token: null });
    expect(banned.headers.getSetCookie?.() ?? []).toEqual([]);
    expect(other.status).toBe(200);
    expect(f.stored("eve@example.test")).toBeUndefined();
    expect(f.stored("adam@example.test")).toBeDefined();
    expect(f.mailsTo("eve@example.test")).toEqual([]);
  });
});

describe("an account made before the mail provider, still unverified", () => {
  it("keeps its open session, and is asked to verify at its next password sign-in", async () => {
    const f = fixture();
    const session = await f.signUp(email, undefined, f.legacy);

    expect(await f.user(session)).toMatchObject({ email, emailVerified: false });
    const signIn = await f.signIn();

    expect(signIn.status).toBe(403);
    expect(await signIn.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(await f.user(session)).toMatchObject({ email, emailVerified: false });
  });
});
