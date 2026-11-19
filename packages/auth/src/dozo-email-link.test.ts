import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dozoEmailLink,
  linkMark,
  MARK_LIFETIME_SECONDS,
  readLinkMark,
  sendVerificationMail,
  takeVerificationMail,
  VERIFICATION_MAILS_PER_HOUR,
  verificationCallbackUrl,
} from "./dozo-email-link.js";
import { authRateLimitOptions, CLIENT_IP_HEADER, createAuth } from "./index.js";

const SECRET = "offline-auth-secret-at-least-32-characters";
const NOW = Date.UTC(2026, 10, 19, 12);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** The `rateLimit` statement of `takeVerificationMail`, played against a map. */
function limiter() {
  const rows = new Map<string, { count: number; lastRequest: bigint }>();
  const $queryRaw = vi.fn(
    async (_sql: TemplateStringsArray, _id: string, key: string, at: bigint, start: bigint) => {
      const row = rows.get(key);
      const next =
        !row || row.lastRequest <= start
          ? { count: 1, lastRequest: at }
          : { count: row.count + 1, lastRequest: row.lastRequest };
      rows.set(key, next);
      return [{ count: next.count }];
    },
  );
  return { rows, $queryRaw: $queryRaw as never };
}

describe("the result page's mark", () => {
  it("names the account it was signed for, until it expires", () => {
    const mark = linkMark(SECRET, "user-1", NOW);
    expect(readLinkMark(SECRET, mark, NOW)).toBe("user-1");
    expect(readLinkMark(SECRET, mark, NOW + MARK_LIFETIME_SECONDS * 1000 - 1000)).toBe("user-1");
    expect(readLinkMark(SECRET, mark, NOW + MARK_LIFETIME_SECONDS * 1000 + 1000)).toBeNull();
  });

  it.each([
    ["another secret", (mark: string) => mark, "another-secret-that-is-long-enough-here"],
    [
      "a changed account",
      (mark: string) =>
        `${Buffer.from("user-2").toString("base64url")}.${mark.split(".").slice(1).join(".")}`,
      SECRET,
    ],
    [
      "a later expiry",
      (mark: string) => mark.replace(/\.(\d+)\./, (_m, n) => `.${Number(n) + 9}.`),
      SECRET,
    ],
    ["a cut signature", (mark: string) => mark.slice(0, -4), SECRET],
    ["no parts", () => "nothing", SECRET],
    ["an empty account", () => linkMark(SECRET, "", NOW), SECRET],
  ])("refuses %s", (_case, change, secret) => {
    expect(readLinkMark(secret, change(linkMark(SECRET, "user-1", NOW)), NOW)).toBeNull();
  });

  it("carries the mark to the web app's result page, never the address", () => {
    const url = new URL(
      verificationCallbackUrl("https://app.example.com/app", SECRET, "user-1", NOW),
    );
    expect(url.origin + url.pathname).toBe("https://app.example.com/verify-email");
    expect([...url.searchParams.keys()]).toEqual(["v"]);
    expect(readLinkMark(SECRET, url.searchParams.get("v") ?? "", NOW)).toBe("user-1");
  });
});

describe("mails per address", () => {
  it(`lets ${VERIFICATION_MAILS_PER_HOUR} an hour through to one address, whatever its case`, async () => {
    const { $queryRaw } = limiter();
    const prisma = { $queryRaw };
    const taken = [];
    for (const email of [
      "ada@example.com",
      "ADA@example.com ",
      "ada@example.com",
      "ada@example.com",
    ])
      taken.push(await takeVerificationMail(prisma, email, NOW));
    expect(taken).toEqual([true, true, true, false]);
    expect(await takeVerificationMail(prisma, "grace@example.com", NOW)).toBe(true);
    expect(await takeVerificationMail(prisma, "ada@example.com", NOW + 60 * 60 * 1000 + 1)).toBe(
      true,
    );
  });

  it("stores a hash of the address, not the address", async () => {
    const { rows, $queryRaw } = limiter();
    await takeVerificationMail({ $queryRaw }, "ada@example.com", NOW);
    const [key = ""] = rows.keys();
    expect(key).toMatch(/^dozo-verification-mail:[0-9a-f]{64}$/);
  });
});

describe("sendVerificationMail", () => {
  const deps = (overrides = {}) => ({
    prisma: limiter(),
    email: { send: vi.fn(async (_mail: unknown) => undefined) },
    secret: SECRET,
    webOrigin: "https://app.example.com",
    localeOf: vi.fn(async () => "tr"),
    onError: vi.fn(),
    ...overrides,
  });

  it("mails the link with the result page as its way back, in the reader's language", async () => {
    const d = deps();
    await sendVerificationMail(
      d as never,
      { id: "user-1", email: "ada@example.com" },
      "https://api.example.com/api/auth/verify-email?token=t&callbackURL=%2F",
    );
    const mail = d.email.send.mock.calls[0]?.[0] as unknown as {
      to: string;
      html: string;
      subject: string;
    };
    expect(mail.to).toBe("ada@example.com");
    expect(mail.subject).toBe("Dozo e-posta adresinizi doğrulayın");
    const href =
      /href="(https:\/\/api\.example\.com[^"]*)"/.exec(mail.html)?.[1]?.replaceAll("&amp;", "&") ??
      "";
    const back = new URL(new URL(href).searchParams.get("callbackURL") ?? "");
    expect(back.pathname).toBe("/verify-email");
    expect(readLinkMark(SECRET, back.searchParams.get("v") ?? "")).toBe("user-1");
    expect(href).not.toContain("ada%40example.com");
  });

  it("sends nothing past the address's share, and says nothing about it", async () => {
    const d = deps();
    for (let i = 0; i < VERIFICATION_MAILS_PER_HOUR + 2; i += 1)
      await sendVerificationMail(
        d as never,
        { id: "u", email: "ada@example.com" },
        "https://api.example.com/v?token=t",
      );
    expect(d.email.send).toHaveBeenCalledTimes(VERIFICATION_MAILS_PER_HOUR);
    expect(d.onError).not.toHaveBeenCalled();
  });

  it("reports a failed delivery or count instead of rejecting", async () => {
    const failure = new Error("smtp down");
    const d = deps({ email: { send: vi.fn().mockRejectedValue(failure) } });
    await expect(
      sendVerificationMail(
        d as never,
        { id: "u", email: "a@example.com" },
        "https://api.example.com/v",
      ),
    ).resolves.toBeUndefined();
    expect(d.onError).toHaveBeenCalledWith(failure);
    const counted = deps({ prisma: { $queryRaw: vi.fn().mockRejectedValue(failure) } });
    await sendVerificationMail(
      counted as never,
      { id: "u", email: "a@example.com" },
      "https://api.example.com/v",
    );
    expect(counted.onError).toHaveBeenCalledWith(failure);
    expect(counted.email.send).not.toHaveBeenCalled();
  });
});

type FakeUser = { id: string; email: string; emailVerified: boolean; name: string };

/** createAuth on a fake database: users by address or id, the shared rate-limit rows. */
function server(
  users: FakeUser[],
  send: ReturnType<typeof vi.fn> = vi.fn(async (_mail: unknown) => undefined),
) {
  const limits = new Map<
    string,
    { id: string; key: string; count: number; lastRequest: unknown }
  >();
  // The adapter's filters: `AND`, and `{ equals | gt | lt }` or a plain value per field.
  const matches = (row: object, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([field, test]) => {
      if (field === "AND") return (test as Record<string, unknown>[]).every((w) => matches(row, w));
      const value = (row as Record<string, unknown>)[field] as number;
      if (!test || typeof test !== "object") return value === test;
      const { equals, gt, lt } = test as { equals?: unknown; gt?: number; lt?: number };
      return (
        (equals === undefined || value === equals) &&
        (gt === undefined || value > gt) &&
        (lt === undefined || value < lt)
      );
    });
  const find = (where?: Record<string, unknown>) =>
    users.find((user) => matches(user, where)) ?? null;
  const write = (row: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(data))
      row[field] =
        value && typeof value === "object" && "increment" in value
          ? (row[field] as number) + (value.increment as number)
          : value;
  };
  const limitRows = (where?: Record<string, unknown>) =>
    [...limits.values()].filter((row) => matches(row, where));
  const { $queryRaw } = limiter();
  const prisma = {
    $queryRaw,
    user: {
      findFirst: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => find(where)),
      findUnique: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => find(where)),
    },
    rateLimit: {
      findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => limitRows(where)),
      findFirst: vi.fn(
        async ({ where }: { where?: Record<string, unknown> }) => limitRows(where)[0] ?? null,
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: { id: string; key: string; count: number; lastRequest: unknown };
        }) => {
          limits.set(data.key, { ...data });
          return data;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where?: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const [found] = limitRows(where);
          if (found) write(found, data);
          return found ?? null;
        },
      ),
    },
  };
  const errors: unknown[] = [];
  const auth = createAuth(prisma as never, {
    secret: SECRET,
    baseURL: "https://api.example.test",
    webOrigin: "https://app.example.test",
    signupsEnabled: "true",
    signupAllowlist: "",
    email: { send, describe: () => ({}) } as never,
    onEmailError: (error) => errors.push(error),
    logger: { disabled: true },
  });
  const ask = (email: string, ip = "203.0.113.7") =>
    auth.handler(
      new Request("https://api.example.test/api/auth/send-verification-email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.test",
          [CLIENT_IP_HEADER]: ip,
        },
        body: JSON.stringify({ email }),
      }),
    );
  return { auth, ask, send, errors };
}

const people: FakeUser[] = [
  { id: "u-new", email: "new@example.com", emailVerified: false, name: "New" },
  { id: "u-done", email: "done@example.com", emailVerified: true, name: "Done" },
];

describe("asking for a verification link, signed out", () => {
  it("answers the same for an unverified, a verified and an unknown address", async () => {
    const { ask, send } = server(people);
    const answers = [];
    for (const email of ["new@example.com", "done@example.com", "nobody@example.com"]) {
      const response = await ask(email);
      answers.push([response.status, await response.text()]);
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]?.[0]).toBe(200);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((send.mock.calls[0] as unknown as [{ to: string }])[0].to).toBe("new@example.com");
  });

  it("answers the same when delivery fails, and reports the failure", async () => {
    const failure = new Error("smtp down");
    const { ask, errors } = server(people, vi.fn().mockRejectedValue(failure));
    const response = await ask("new@example.com");
    expect([response.status, await response.json()]).toEqual([200, { status: true }]);
    await vi.waitFor(() => expect(errors).toEqual([failure]));
  });

  it("does not wait for delivery", async () => {
    const held = deferred<undefined>();
    const send = vi.fn(() => held.promise);
    const { ask } = server(people, send);
    expect((await ask("new@example.com")).status).toBe(200);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    held.resolve(undefined);
  });
});

describe("the per-IP limit on asking for a link", () => {
  it("is 3 per 10 minutes, kept in the shared table", () => {
    expect(authRateLimitOptions("production").customRules["/send-verification-email"]).toEqual({
      window: 600,
      max: 3,
    });
  });

  it("refuses the fourth ask from one address the same way, whichever address it names", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { ask } = server(people);
    for (const email of ["new@example.com", "done@example.com", "nobody@example.com"])
      expect((await ask(email)).status).toBe(200);
    const refused = await Promise.all(
      ["new@example.com", "nobody@example.com"].map(async (email) => {
        const response = await ask(email);
        return [response.status, await response.text()];
      }),
    );
    expect(refused[0]?.[0]).toBe(429);
    expect(refused[1]).toEqual(refused[0]);
    expect((await ask("new@example.com", "198.51.100.9")).status).toBe(200);
  });
});

describe("GET /dozo/email-link", () => {
  const read = (auth: ReturnType<typeof server>["auth"], v: string) =>
    auth
      .handler(
        new Request(`https://api.example.test/api/auth/dozo/email-link?v=${encodeURIComponent(v)}`),
      )
      .then(async (response) => [response.status, await response.json()]);

  it("says whether the marked account is verified, with its address", async () => {
    const { auth } = server(people);
    expect(await read(auth, linkMark(SECRET, "u-done"))).toEqual([
      200,
      { verified: true, email: "done@example.com" },
    ]);
    expect(await read(auth, linkMark(SECRET, "u-new"))).toEqual([
      200,
      { verified: false, email: "new@example.com" },
    ]);
  });

  it("gives one empty answer to a forged mark, a gone account and no mark", async () => {
    const { auth } = server(people);
    const empty = [200, { verified: false, email: null }];
    expect(await read(auth, linkMark("another-secret-that-is-long-enough-here", "u-done"))).toEqual(
      empty,
    );
    expect(await read(auth, linkMark(SECRET, "u-gone"))).toEqual(empty);
    expect(await read(auth, "")).toEqual(empty);
  });

  it("is a plugin of its own", () => {
    expect(dozoEmailLink().id).toBe("dozo-email-link");
  });
});
