import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOSTED_PROVIDER_ID } from "./dozo-hosted-login.js";
import { createAuth } from "./index.js";

/**
 * Both ends through the real `createAuth`, as the brand rules wire them: its session hook,
 * single-account admission and request hooks run around the hosted login.
 */

// Better Auth's real routes over its offline memory adapter, as the other auth tests do.
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@rakazo/db", async (importOriginal) => {
  const { signupPolicyFromEnv } = await import("@rakazo/core");
  return {
    ...(await importOriginal<typeof import("@rakazo/db")>()),
    siteSignupPolicy: vi.fn(async (_db: unknown, env: Parameters<typeof signupPolicyFromEnv>[0]) =>
      signupPolicyFromEnv(env),
    ),
    bootstrapUserSpace: vi.fn(async (prisma: Fake, user: { id: string }) => {
      prisma.members.push(user.id);
      return { spaceId: `space-${user.id}` };
    }),
    leaveInvitedSpaces: vi.fn(async () => ({ ownedOrganizationIds: [] })),
    recordSecurityEvent: vi.fn(async () => undefined),
  };
});

const HOSTED = "https://accounts.dozo.example";
const LOCAL = "http://127.0.0.1:5173";
const SECRET = "offline-auth-secret-at-least-32-characters";
const PASSWORD = "offline-password-1234";

type Fake = ReturnType<typeof fakePrisma>;

/** What createAuth and the hosted login ask Prisma for, over the adapter's own rows. */
function fakePrisma() {
  const authData: Record<
    "user" | "account" | "session" | "verification",
    Record<string, unknown>[]
  > = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  const members: string[] = [];
  const prisma = {
    authData,
    members,
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        signupsEnabled: true,
        signupAllowlist: "",
        signupPolicyInitialized: true,
      })),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id?: { not: string } } }) =>
        authData.user
          .filter((user) => user.id !== where.id?.not)
          .map((user) => ({ id: user.id as string })),
      ),
      findUnique: vi.fn(async () => null),
    },
    spaceMember: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string | { in: string[] } } }) => {
        const ids = typeof where.userId === "string" ? [where.userId] : where.userId.in;
        const found = members.find((id) => ids.includes(id));
        return found ? { userId: found, spaceId: `space-${found}` } : null;
      }),
    },
    member: { findMany: vi.fn(async () => []) },
    organization: { findUnique: vi.fn(async () => null) },
  };
  return prisma;
}

function server(baseURL: string, env: Record<string, string>) {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const prisma = fakePrisma();
  const auth = createAuth(prisma as never, {
    secret: SECRET,
    baseURL,
    webOrigin: baseURL,
    signupsEnabled: "true",
    signupAllowlist: "",
    singleAccount: baseURL === LOCAL,
  });
  vi.unstubAllEnvs();
  return { prisma, auth };
}

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

function post(auth: ReturnType<typeof createAuth>, base: string, path: string, body: unknown) {
  return auth.handler(
    new Request(`${base}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stack() {
  const key = String(
    generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  const hosted = server(HOSTED, { HOSTED_LOGIN_SIGNING_KEY: key });
  const local = server(LOCAL, { HOSTED_LOGIN_ISSUER: HOSTED });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => hosted.auth.handler(new Request(input))),
  );

  async function account(email: string) {
    const response = await post(hosted.auth, HOSTED, "/sign-up/email", {
      email,
      password: PASSWORD,
      name: email.split("@")[0],
    });
    expect(response.status).toBe(200);
    return cookieOf(response);
  }

  async function signIn(hostedCookie: string) {
    const start = await local.auth.handler(
      new Request(`${LOCAL}/api/auth/dozo/hosted-login/start`),
    );
    const page = new URL(start.headers.get("location")!);
    const issued = await hosted.auth.handler(
      new Request(`${HOSTED}/api/auth/dozo/hosted-login/issue`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: HOSTED, cookie: hostedCookie },
        body: JSON.stringify({
          audience: page.searchParams.get("audience"),
          return: page.searchParams.get("return"),
        }),
      }),
    );
    expect(issued.status).toBe(200);
    const { url } = (await issued.json()) as { url: string };
    return local.auth.handler(new Request(url, { headers: { cookie: cookieOf(start) } }));
  }

  return { hosted, local, account, signIn };
}

describe("hosted login through createAuth", () => {
  it("admits the first hosted account as the install's sole account, with its workspace", async () => {
    const s = stack();
    const done = await s.signIn(await s.account("ada@dozo.example"));
    expect(done.headers.get("location")).toBe(`${LOCAL}/`);
    const [user] = s.local.prisma.authData.user;
    expect(user).toMatchObject({ email: "ada@dozo.example" });
    expect(s.local.prisma.authData.account).toEqual([
      expect.objectContaining({ providerId: HOSTED_PROVIDER_ID, userId: user!.id }),
    ]);
    expect(s.local.prisma.members).toEqual([user!.id]);
    const session = await s.local.auth.api.getSession({
      headers: new Headers({ cookie: cookieOf(done) }),
    });
    expect(session?.user.email).toBe("ada@dozo.example");
  });

  it("refuses a second hosted account and keeps the first one's", async () => {
    const s = stack();
    await s.signIn(await s.account("ada@dozo.example"));
    const done = await s.signIn(await s.account("eve@dozo.example"));
    expect(done.headers.get("location")).toBe(`${LOCAL}/sign-in?error=hosted_login_failed`);
    expect(s.local.prisma.authData.user).toHaveLength(1);
  });

  it("closes password sign-up and sign-in on the local server only", async () => {
    const s = stack();
    const body = { email: "eve@dozo.example", password: PASSWORD, name: "Eve" };
    expect((await post(s.local.auth, LOCAL, "/sign-up/email", body)).status).toBe(404);
    expect((await post(s.local.auth, LOCAL, "/sign-in/email", body)).status).toBe(404);
    expect(s.local.prisma.authData.user).toEqual([]);
    expect((await post(s.hosted.auth, HOSTED, "/sign-up/email", body)).status).toBe(200);
  });

  it("changes nothing when neither variable is set", async () => {
    const { prisma, auth } = server(LOCAL, {});
    const start = await auth.handler(new Request(`${LOCAL}/api/auth/dozo/hosted-login/start`));
    expect(start.status).toBe(404);
    const body = { email: "eve@dozo.example", password: PASSWORD, name: "Eve" };
    expect((await post(auth, LOCAL, "/sign-up/email", body)).status).toBe(200);
    expect(prisma.authData.user).toHaveLength(1);
  });
});
