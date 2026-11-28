import { signJWT } from "better-auth/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendVerificationMail } from "./dozo-email-link.js";
import { banEntry } from "./dozo-operator.js";
import type { Fixture } from "./dozo-signup.test-support.js";
import {
  challengeCookie,
  disposeFixtures,
  email,
  fixture,
  otherPassword,
  password,
  providerClaims,
  SECRET,
  softwareAuthenticator,
  webOrigin,
} from "./dozo-signup.test-support.js";

// Someone registers another person's address with a password of their own, before that person
// does: what the mailbox owner can do, and what the squatter cannot. Better Auth's real routes
// over its offline memory adapter (dozo-signup.test-support.ts); the identity provider and Google
// are faked at their network edge, as upstream's oidc.test.ts does.
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
    personalOrganizationIds: vi.fn(async () => []),
    clearAccountIdentity: vi.fn(async () => undefined),
    recordSecurityEvent: vi.fn(async () => undefined),
    runAsSystem: vi.fn(async (_reason: string, run: () => unknown) => run()),
  };
});
// The real sender, watched so a test can wait until a mail it started has finished or given up.
vi.mock("./dozo-email-link.js", async (original) => {
  const real = await original<typeof import("./dozo-email-link.js")>();
  return { ...real, sendVerificationMail: vi.fn(real.sendVerificationMail) };
});

afterEach(() => {
  disposeFixtures();
  vi.useRealTimers();
});

const victimPassword = "mailbox-owner-password-9012";
const sessionCookie = /session_token/;

/** The squatter registers the victim's address; the victim opens the mailed link, signed out. */
async function squatted(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options);
  await f.signUp();
  const opened = await f.openLink();
  expect(opened.status).toBe(302);
  expect(f.stored()).toMatchObject({ emailVerified: false });
  return { f, victim: f.cookieOf(opened) };
}

const revokedUnproven = (f: Fixture) => {
  const userId = f.stored()?.id;
  expect(f.prisma.passkey.deleteMany).toHaveBeenCalledWith({ where: { userId } });
  expect(f.prisma.account.deleteMany).toHaveBeenCalledWith({
    where: { userId, providerId: { not: "credential" } },
  });
  expect(f.prisma.messagingIdentity.deleteMany).toHaveBeenCalledWith({ where: { userId } });
  expect(f.prisma.messagingLinkCode.deleteMany).toHaveBeenCalledWith({ where: { userId } });
  expect(f.devices).toHaveBeenCalledWith({
    where: { userId, revokedAt: null },
    data: { revokedAt: expect.any(Date) },
  });
};

describe("an address someone else registered with their own password", () => {
  it("is taken back by its owner with a code, in the browser holding the link", async () => {
    const { f, victim } = await squatted();

    const signedIn = await f.codeSignIn(email, victim);

    expect(signedIn.status).toBe(200);
    expect(await f.user(f.cookieOf(signedIn, victim))).toMatchObject({
      email,
      emailVerified: true,
    });
    expect((await f.signIn()).status).toBe(401);
    revokedUnproven(f);
  });

  it("is taken back by its owner with a password reset, and only the owner's password is left", async () => {
    const { f, victim } = await squatted();
    expect(
      (await f.call("/request-password-reset", { email, redirectTo: `${webOrigin}/reset` }, victim))
        .status,
    ).toBe(200);
    const token = await vi.waitFor(() => {
      const found = f.messages.findLast((m) => m.to === email && m.text.includes("reset-password"));
      if (!found) throw new Error("no reset mail yet");
      return found.text.match(/reset-password\/([^?\s]+)/)![1] as string;
    });

    const reset = await f.call("/reset-password", { token, newPassword: victimPassword }, victim);

    expect(reset.status).toBe(200);
    revokedUnproven(f);
    expect((await f.signIn()).status).toBe(401);
    // The reset proves the mailbox but does not verify; the browser holding the link does.
    const signedIn = await f.signIn(victim, victimPassword);
    expect(signedIn.status).toBe(200);
    expect(f.stored()).toMatchObject({ emailVerified: true });
    expect(f.accountsOf()).toHaveLength(1);
    expect((await f.signIn()).status).toBe(401);
    expect((await f.signIn(undefined, victimPassword)).status).toBe(200);
  });

  it.each(["oidc", "google"] as const)(
    "is not signed in to or linked by %s with the same verified address, link or not",
    async (provider) => {
      const { f, victim } = await squatted({ oidc: true, google: true });

      const signIn = await f.providerSignIn(provider, providerClaims(), { cookie: victim });

      expect(signIn.response.headers.get("location")).toContain("error=account_not_linked");
      expect(signIn.cookie).not.toMatch(sessionCookie);
      expect(f.prisma.authData.user).toHaveLength(1);
      expect(f.accountsOf().map((account) => account.providerId)).toEqual(["credential"]);
      expect(f.stored()).toMatchObject({ emailVerified: false });
      // The squatter has no session to link from: sign-up gave none and the password gives none.
      expect((await f.signIn()).status).toBe(403);
      const unauthenticated = await f.call("/link-social", {
        provider,
        callbackURL: `${webOrigin}/app`,
      });
      expect(unauthenticated.status).toBe(401);
    },
  );

  it("is not verified by a held link that has expired, with the right password", async () => {
    const { f, victim } = await squatted();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);

    const attempt = await f.signIn(victim);

    expect(attempt.status).toBe(403);
    expect(await attempt.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(f.stored()).toMatchObject({ emailVerified: false });
  });

  it("is not verified by a forged link signed to have expired already", async () => {
    const f = fixture();
    await f.signUp();
    const expired = await signJWT({ email }, SECRET, -60);

    const attempt = await f.signIn(`dozo_pending_verification=${expired}`);

    expect(attempt.status).toBe(403);
    expect(f.stored()).toMatchObject({ emailVerified: false });
  });
});

describe("a banned address with an unverified account", () => {
  it("gets no mail when it signs in with its password", async () => {
    const f = fixture();
    await f.signUp();
    await vi.waitFor(() => expect(f.mailsTo(email)).toHaveLength(1));
    f.banned.add(banEntry(email) as string);
    const sends = vi.mocked(sendVerificationMail);
    const before = sends.mock.calls.length;

    const refused = await f.signIn();

    expect(refused.status).toBe(403);
    // The sender was asked, and has finished: it sent nothing.
    await vi.waitFor(() => expect(sends.mock.calls.length).toBe(before + 1));
    await sends.mock.results.at(-1)?.value;
    expect(f.mailsTo(email)).toHaveLength(1);
  });
});

describe("a deactivated account that never proved its address", () => {
  it("gets no mail when it signs in with its password", async () => {
    const f = fixture();
    await f.signUp();
    await vi.waitFor(() => expect(f.mailsTo(email)).toHaveLength(1));
    f.stored()!.deactivatedAt = new Date();
    const sends = vi.mocked(sendVerificationMail);
    const before = sends.mock.calls.length;

    const refused = await f.signIn();

    expect(refused.status).toBe(403);
    expect(refused.headers.getSetCookie().join()).not.toMatch(sessionCookie);
    // The sender was asked, and has finished: it sent nothing.
    await vi.waitFor(() => expect(sends.mock.calls.length).toBe(before + 1));
    await sends.mock.results.at(-1)?.value;
    expect(f.mailsTo(email)).toHaveLength(1);
  });
});

describe("a password sign-up from the mobile app", () => {
  const app = { origin: "rakazo://", "x-rakazo-signup-surface": "ios", "accept-language": "en" };

  it("carries no session token in its body, its headers or a cookie", async () => {
    const f = fixture();

    const response = await f.call(
      "/sign-up/email",
      { email, password, name: "Ada" },
      undefined,
      app,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: null, user: { email } });
    expect(response.headers.get("set-auth-token")).toBeNull();
    expect(response.headers.getSetCookie?.().join()).not.toMatch(sessionCookie);
    expect(f.prisma.authData.session).toEqual([]);
    const signIn = await f.call("/sign-in/email", { email, password }, undefined, app);
    expect(signIn.status).toBe(403);
    expect(signIn.headers.get("set-auth-token")).toBeNull();
  });
});

describe("linking a provider to an account that never proved its address", () => {
  it.each(["oidc", "google"] as const)(
    "refuses %s for the account's own session, and links once it is verified",
    async (provider) => {
      const f = fixture({ oidc: true, google: true });
      const session = await f.oldAccount();

      const refused = await f.providerSignIn(provider, providerClaims(), {
        link: true,
        cookie: session,
      });

      expect(refused.response.headers.get("location")).toContain("error=unable_to_link_account");
      expect(f.accountsOf().map((account) => account.providerId)).toEqual(["credential"]);
      expect((await f.openLink(session)).status).toBeLessThan(400);
      const linked = await f.providerSignIn(provider, providerClaims(), {
        link: true,
        cookie: session,
      });
      expect(linked.response.headers.get("location")).toBe(`${webOrigin}/app`);
      expect(f.accountsOf().map((account) => account.providerId)).toEqual(["credential", provider]);
    },
  );

  it.each([false, undefined])(
    "refuses a provider claim of an unverified address (%s), even to a verified account",
    async (verified) => {
      const f = fixture({ oidc: true });
      const session = await f.verifiedAccount(email);

      const refused = await f.providerSignIn("oidc", providerClaims({ email_verified: verified }), {
        link: true,
        cookie: session,
      });

      expect(refused.response.headers.get("location")).toContain("error=unable_to_link_account");
      expect(f.accountsOf()).toHaveLength(1);
    },
  );

  it("refuses a link started by the account but finished in another browser", async () => {
    const f = fixture({ oidc: true });
    const session = await f.oldAccount();
    const started = await f.startProvider("oidc", providerClaims(), {
      link: true,
      cookie: session,
    });
    const proxy = `/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: started.authorizeURL })}`;
    const elsewhere = f.cookieOf(await f.call(proxy));

    const finished = await f.call(started.callback, undefined, elsewhere);

    expect(finished.headers.get("location")).toContain("error=unable_to_link_account");
    expect(f.accountsOf().map((account) => account.providerId)).toEqual(["credential"]);
  });

  it("links a verified account from the app's browser", async () => {
    const f = fixture({ oidc: true });
    const session = await f.verifiedAccount(email);
    const started = await f.startProvider("oidc", providerClaims(), {
      link: true,
      cookie: session,
      callbackURL: "rakazo://account",
    });
    const proxy = `/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: started.authorizeURL })}`;
    const appBrowser = f.cookieOf(await f.call(proxy));

    const finished = await f.call(started.callback, undefined, appBrowser);

    expect(new URL(finished.headers.get("location") ?? "").protocol).toBe("rakazo:");
    expect(f.accountsOf().map((account) => account.providerId)).toEqual(["credential", "oidc"]);
  });

  it("links Google only to the signed-in account's own verified address", async () => {
    const f = fixture({ google: true });
    const session = await f.verifiedAccount(email);

    const other = await f.providerSignIn(
      "google",
      providerClaims({ email: "other@example.test" }),
      { link: true, cookie: session },
    );

    expect(other.response.headers.get("location")).toContain("error=email_does_not_match");
    expect(f.accountsOf()).toHaveLength(1);
  });
});

describe("a code sign-in by the owner of an address an older account squatted", () => {
  it("ends the squatter's sessions and drops their provider links and password", async () => {
    const f = fixture();
    const squatter = await f.oldAccount();
    const userId = f.stored()?.id;
    f.prisma.authData.account.push({
      id: "oidc-link",
      userId,
      providerId: "oidc",
      accountId: "squatter-subject",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const owner = await f.codeSignIn();

    expect(owner.status).toBe(200);
    expect(f.prisma.authData.user).toHaveLength(1);
    expect(f.stored()).toMatchObject({ id: userId, emailVerified: true });
    expect(await f.user(squatter)).toBeNull();
    expect(f.accountsOf()).toHaveLength(0);
    expect((await f.signIn()).status).toBe(401);
    expect(await f.user(f.cookieOf(owner))).toMatchObject({ id: userId });
    revokedUnproven(f);
  });
});

describe("passkeys on an account that never proved its address", () => {
  const https = { origin: "https://auth.example.test", web: "https://web.example.test" };
  const passkeys = (f: Fixture) => {
    const authenticator = softwareAuthenticator("web.example.test", https.web);
    const register = async (session: string) => {
      const options = await f.call("/passkey/generate-register-options", undefined, session);
      expect(options.status).toBe(200);
      const { challenge } = (await options.json()) as { challenge: string };
      return f.call(
        "/passkey/verify-registration",
        { response: authenticator.create(challenge) },
        `${session}; ${challengeCookie(options)}`,
      );
    };
    const signIn = async () => {
      const options = await f.call("/passkey/generate-authenticate-options");
      const { challenge } = (await options.json()) as { challenge: string };
      return f.call(
        "/passkey/verify-authentication",
        { response: authenticator.get(challenge) },
        challengeCookie(options),
      );
    };
    return { register, signIn };
  };

  it("are dropped when the mailbox owner signs in with a code", async () => {
    const f = fixture(https);
    const keys = passkeys(f);
    const squatter = await f.oldAccount();
    expect((await keys.register(squatter)).status).toBe(200);
    expect(f.prisma.authData.passkey).toHaveLength(1);

    expect((await f.codeSignIn()).status).toBe(200);

    expect(f.prisma.authData.passkey).toHaveLength(0);
    expect((await keys.signIn()).status).toBe(401);
    revokedUnproven(f);
  });

  it("are kept on a verified account's code sign-in", async () => {
    const f = fixture(https);
    const keys = passkeys(f);
    const session = await f.verifiedAccount(email);
    expect((await keys.register(session)).status).toBe(200);

    expect((await f.codeSignIn()).status).toBe(200);

    expect(f.prisma.authData.passkey).toHaveLength(1);
    expect(f.devices).not.toHaveBeenCalled();
    expect((await keys.signIn()).status).toBe(200);
  });
});

describe("what an unverified account's session can still do", () => {
  it("confirms its identity only with its password, never an emailed code", async () => {
    const f = fixture();
    const session = await f.oldAccount();

    const requested = await f.call("/request-identity-code", {}, session);

    expect(await requested.json()).toMatchObject({ code: "EMAIL_CODE_UNAVAILABLE" });
    expect((await f.call("/confirm-identity", { code: "123456" }, session)).status).toBe(400);
  });

  it("deletes the account only with its password", async () => {
    const f = fixture();
    const session = await f.oldAccount();

    for (const body of [{}, { password: "" }, { password: otherPassword }])
      expect((await f.call("/delete-user", body, session)).status).toBe(400);

    expect((await f.call("/delete-user", { password }, session)).status).toBe(200);
    expect(f.stored()).toBeUndefined();
  });
});

describe("a deactivated account", () => {
  it("is refused, verified or not, and its open session ends", async () => {
    const f = fixture();
    const session = await f.verifiedAccount(email);
    await f.signUp("bob@example.test");
    for (const row of f.prisma.authData.user) row.deactivatedAt = new Date();

    expect(await f.user(session)).toBeNull();
    const verified = await f.signIn();
    expect(verified.status).toBe(403);
    expect(await verified.json()).toMatchObject({ code: "ACCOUNT_DEACTIVATED" });
    const unverified = await f.signIn(undefined, password, "bob@example.test");
    expect(unverified.status).toBe(403);
    expect(unverified.headers.getSetCookie?.().join()).not.toMatch(sessionCookie);
  });
});

describe("a deployment that admits sign-ups only from some requests, with a mail provider", () => {
  it("makes an account only for an accepted request, which still proves its mailbox", async () => {
    let accepted = true;
    const f = fixture({ admitsSignup: () => accepted });
    // An accepted sign-up that has not proved its address has no session.
    expect(await f.signUp("owner@example.test")).not.toMatch(sessionCookie);
    await f.verifiedAccount("second@example.test");
    accepted = false;
    const sent = f.messages.length;

    const stranger = await f.register("stranger@example.test");
    const asked = await f.call("/email-otp/send-verification-otp", {
      email: "someone@example.test",
      type: "sign-in",
    });

    expect(stranger.status).toBe(400);
    expect(await stranger.json()).toMatchObject({ code: "REGISTRATION_CLOSED" });
    expect(f.stored("stranger@example.test")).toBeUndefined();
    expect(asked.status).toBe(200);
    expect(f.messages).toHaveLength(sent);
    // The account an accepted request made is not undone by the deployment closing later: it
    // gets its session once it proves its mailbox, and the stranger's address got no mail to prove.
    const proved = await f.openLink(undefined, undefined, "owner@example.test");
    const owner = await f.signIn(f.cookieOf(proved), password, "owner@example.test");
    expect(owner.status).toBe(200);
    expect(f.cookieOf(owner)).toMatch(sessionCookie);
    expect(f.mailsTo("stranger@example.test")).toHaveLength(0);
  });
});
