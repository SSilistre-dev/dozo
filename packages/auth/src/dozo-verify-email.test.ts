import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { verifyEmailAdapter } from "./dozo-verify-email.js";
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

function fixture() {
  const messages: TransactionalEmail[] = [];
  const devices = vi.fn(async () => ({ count: 0 }));
  const prisma = {
    authData: { user: [], account: [], session: [], verification: [] },
    // The ban list is empty.
    $queryRaw: vi.fn(async () => []),
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
    baseURL,
    webOrigin,
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
      new Request(`${baseURL}/api/auth${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          origin: webOrigin,
          ...(cookie ? { cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const cookieOf = (response: Response) =>
    (response.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const signUp = async () => {
    const response = await call("/sign-up/email", { email, password, name: "Ada" });
    expect(response.status).toBe(200);
    return cookieOf(response);
  };
  const signIn = () => call("/sign-in/email", { email, password });
  /** Opens the link of the last verification mail, in a browser holding `cookie` or none. */
  const openLink = (cookie?: string) => {
    const mail = messages.findLast((message) => message.subject.startsWith("Verify"));
    const url = new URL(mail!.text.match(/http:\/\/\S+/)![0]);
    return call(`${url.pathname.replace("/api/auth", "")}${url.search}`, undefined, cookie);
  };
  const user = async (cookie: string) =>
    (await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user ?? null;
  return { prisma, messages, devices, call, cookieOf, signUp, signIn, openLink, user };
}

describe("the emailed verification link", () => {
  it("opened where the account is not signed in, leaves only the mailbox as a way in", async () => {
    const f = fixture();
    const earlier = await f.signUp();
    expect(await f.user(earlier)).toMatchObject({ email, emailVerified: false });

    expect((await f.openLink()).status).toBeLessThan(400);

    expect(await f.user(earlier)).toBeNull();
    expect((await f.signIn()).status).toBe(401);
    expect(f.devices).toHaveBeenCalled();
    // The owner signs in with a code, verified.
    expect(
      (await f.call("/email-otp/send-verification-otp", { email, type: "sign-in" })).status,
    ).toBe(200);
    const otp = f.messages.at(-1)!.text.match(/\b\d{6}\b/)![0];
    const signedIn = await f.call("/sign-in/email-otp", { email, otp });
    expect(signedIn.status).toBe(200);
    expect(await f.user(f.cookieOf(signedIn))).toMatchObject({ email, emailVerified: true });
  });

  it("opened where the account is signed in, keeps that session and the password", async () => {
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

  it("leaves an account another opening verified meanwhile as it is", async () => {
    const internalAdapter = {
      findUserByEmail: vi.fn(async () => ({ user: { id: "ada", emailVerified: true } })),
      findAccounts: vi.fn(),
      deleteAccount: vi.fn(),
      deleteUserSessions: vi.fn(),
      updateUserByEmail: vi.fn(async () => ({ id: "ada" })),
    };
    const revoke = vi.fn();
    const adapter = verifyEmailAdapter({ context: { internalAdapter } } as never, revoke);

    await adapter.updateUserByEmail(email, { emailVerified: true });

    expect(internalAdapter.updateUserByEmail).toHaveBeenCalledWith(email, { emailVerified: true });
    expect(internalAdapter.deleteUserSessions).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });
});
