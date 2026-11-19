import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import type { AccountDeletionAuth } from "./dozo-operator.js";
import {
  addBan,
  banEntry,
  banKeys,
  bannedEntries,
  deleteAccountAsOperator,
  emailBanned,
  listBans,
  refuseBanned,
  removeBan,
} from "./dozo-operator.js";
import { createAuth } from "./index.js";

// Better Auth's real routes over its offline memory adapter, as the password policy tests do.
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
    // No admin site setting here: the sign-up policy is the environment's, as before.
    siteSignupPolicy: vi.fn(async (_db: unknown, env: Parameters<typeof signupPolicyFromEnv>[0]) =>
      signupPolicyFromEnv(env),
    ),
    bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })),
    leaveInvitedSpaces: vi.fn(async () => ({ ownedOrganizationIds: [] })),
    recordSecurityEvent: vi.fn(async () => undefined),
  };
});

/** The fork's table behind the two SQL entry points the module uses. */
function banTable() {
  const rows = new Map<string, { createdAt: Date; createdByUserId: string }>();
  return {
    rows,
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, value: unknown) =>
      sql.join("").includes('"createdAt"')
        ? [...rows].slice(0, value as number).map(([key, row]) => ({ value: key, ...row }))
        : (value as string[]).filter((key) => rows.has(key)).map((key) => ({ value: key })),
    ),
    $executeRaw: vi.fn(async (sql: TemplateStringsArray, value: string, by?: string) => {
      if (!sql.join("").includes("INSERT")) rows.delete(value);
      else if (!rows.has(value))
        rows.set(value, { createdAt: new Date(0), createdByUserId: by as string });
      return 1;
    }),
  };
}

describe("ban entries", () => {
  it.each([
    ["Ada@Example.COM", "ada@example.com"],
    ["  ada+news@example.com ", "ada@example.com"],
    ["ada+a+b@mail.example.com", "ada@mail.example.com"],
    ["+tag@example.com", "+tag@example.com"],
    ["E.v.e+x@Gmail.com", "eve@gmail.com"],
    ["eve@googlemail.com", "eve@gmail.com"],
    ["googlemail.com", "gmail.com"],
    ["e.ve@example.com", "e.ve@example.com"],
    ["Example.com", "example.com"],
    ["@example.com", "example.com"],
    ["*.example.com", "example.com"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
  ])("stores %s as %s", (input, entry) => {
    expect(banEntry(input)).toBe(entry);
  });

  it.each([
    "",
    "com",
    "ada@localhost",
    "a b@example.com",
    "a@b@example.com",
    "exa mple.com",
    "-bad.example.com",
    "a..example.com",
    `${"a".repeat(250)}.com`,
  ])("refuses %j", (input) => {
    expect(banEntry(input)).toBeNull();
  });

  it("names the address, its domain and every parent domain down to two labels", () => {
    expect(banKeys("Eve+x@Mail.Corp.Example.com")).toEqual([
      "eve@mail.corp.example.com",
      "mail.corp.example.com",
      "corp.example.com",
      "example.com",
    ]);
    expect(banKeys("eve@example.com")).toEqual(["eve@example.com", "example.com"]);
    // A spelling no operator could enter still finds its domain.
    expect(banKeys("+x@Example.com.")).toEqual(["+x@example.com", "example.com"]);
    expect(banKeys("a b@-odd-.example.com")).toContain("example.com");
    expect(banKeys("eve@localhost")).toEqual([]);
    // One mailbox behind two domains and any dots; a name of dots alone stays whole.
    expect(banKeys("E.V.E+x@googlemail.com")).toEqual(["eve@gmail.com", "gmail.com"]);
    expect(banKeys("..@gmail.com")).toEqual(["..@gmail.com", "gmail.com"]);
    expect(banKeys("e.ve@mail.example.com")[0]).toBe("e.ve@mail.example.com");
    // Not an address: nothing can refuse it.
    expect(banKeys("example.com")).toEqual([]);
    expect(banKeys("not an address")).toEqual([]);
  });
});

describe("the ban list", () => {
  it("adds once, lists, finds and removes", async () => {
    const table = banTable();
    await addBan(table as never, "eve@example.com", "admin-1");
    await addBan(table as never, "eve@example.com", "admin-2");
    await addBan(table as never, "corp.test", "admin-1");
    expect(table.rows.get("eve@example.com")?.createdByUserId).toBe("admin-1");
    expect((await listBans(table as never)).map((row) => row.value)).toEqual([
      "eve@example.com",
      "corp.test",
    ]);
    expect(
      await bannedEntries(table as never, ["EVE+1@example.com", "x@a.corp.test", "ok@fine.test"]),
    ).toEqual(new Set(["eve@example.com", "corp.test"]));
    expect(await emailBanned(table as never, "someone@corp.test")).toBe(true);
    expect(await emailBanned(table as never, "someone@notcorp.test")).toBe(false);
    await removeBan(table as never, "corp.test");
    expect(await emailBanned(table as never, "someone@corp.test")).toBe(false);
  });

  it("asks the database nothing for what is not an address", async () => {
    const table = banTable();
    expect(await emailBanned(table as never, "tg-1")).toBe(false);
    expect(table.$queryRaw).not.toHaveBeenCalled();
  });

  it("refuses a banned address with the answer a deactivated account gets", async () => {
    const table = banTable();
    await addBan(table as never, "corp.test", "admin-1");
    await expect(refuseBanned(table as never, "ok@fine.test")).resolves.toBeUndefined();
    await expect(refuseBanned(table as never, "eve@corp.test")).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: "ACCOUNT_DEACTIVATED", message: "This account is deactivated" },
    });
  });
});

describe("the operator deleting an account", () => {
  function fixture() {
    const steps: string[] = [];
    const step = (name: string) =>
      vi.fn(async (..._args: unknown[]): Promise<unknown> => void steps.push(name));
    const user = { id: "u1", email: "ada@example.test" };
    const hooks = { beforeDelete: step("content"), afterDelete: step("recorded") };
    const adapter = {
      findUserById: vi.fn(async (id: string) => (id === user.id ? user : null)),
      deleteUser: step("account"),
      deleteUserSessions: step("sessions"),
    };
    const auth: AccountDeletionAuth = {
      $context: Promise.resolve({ internalAdapter: adapter }),
      options: { user: { deleteUser: hooks } },
    };
    return { steps, user, hooks, adapter, auth };
  }

  it("runs the steps of the account's own deletion, in its order", async () => {
    const f = fixture();
    expect(await deleteAccountAsOperator(f.auth, "u1")).toBe(true);
    expect(f.steps).toEqual(["content", "account", "sessions", "recorded"]);
    expect(f.hooks.beforeDelete).toHaveBeenCalledWith(f.user);
    expect(f.adapter.deleteUser).toHaveBeenCalledWith("u1");
  });

  it("does nothing for an account that does not exist", async () => {
    const f = fixture();
    expect(await deleteAccountAsOperator(f.auth, "nobody")).toBe(false);
    expect(f.steps).toEqual([]);
  });

  it("deletes the rows even when the server set no hooks", async () => {
    const f = fixture();
    expect(await deleteAccountAsOperator({ ...f.auth, options: {} }, "u1")).toBe(true);
    expect(f.steps).toEqual(["account", "sessions"]);
  });

  it("keeps the account when its content could not be deleted", async () => {
    const f = fixture();
    f.hooks.beforeDelete.mockRejectedValueOnce(new Error("provider down"));
    await expect(deleteAccountAsOperator(f.auth, "u1")).rejects.toThrow("provider down");
    // Another deletion under way is the caller's to retry, not a server fault.
    f.hooks.beforeDelete.mockRejectedValueOnce(
      new APIError("CONFLICT", { message: "Deletion in progress" }),
    );
    await expect(deleteAccountAsOperator(f.auth, "u1")).rejects.toMatchObject({
      name: "ClientError",
      kind: "CONFLICT",
      message: "Deletion in progress",
    });
    expect(f.steps).toEqual([]);
  });
});

describe("a banned address at the door", () => {
  const baseURL = "http://auth.example.test";
  const webOrigin = "http://web.example.test";
  const password = "offline-password-1234";

  function fixture() {
    const table = banTable();
    const prisma = {
      ...table,
      authData: { user: [], account: [], session: [], verification: [] },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          signupsEnabled: true,
          signupAllowlist: "",
          signupPolicyInitialized: true,
        })),
      },
      spaceMember: { findFirst: vi.fn(async () => ({ spaceId: "space-1" })) },
    };
    const auth = createAuth(prisma as never, {
      secret: "offline-auth-secret-at-least-32-characters",
      baseURL,
      webOrigin,
      signupsEnabled: "true",
      signupAllowlist: "",
    });
    const post = (path: string, body: unknown) =>
      auth.handler(
        new Request(`${baseURL}/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: webOrigin },
          body: JSON.stringify(body),
        }),
      );
    return {
      prisma,
      auth,
      ban: (value: string) => addBan(prisma as never, banEntry(value) as string, "admin"),
      unban: (value: string) => removeBan(prisma as never, value),
      signUp: (email: string) => post("/sign-up/email", { email, password, name: "Eve" }),
      signIn: (email: string) => post("/sign-in/email", { email, password }),
    };
  }
  // What a deactivated account is told: nothing about a list.
  const refused = { code: "ACCOUNT_DEACTIVATED", message: "This account is deactivated" };

  it("cannot sign up, in any spelling, until the ban is lifted", async () => {
    const f = fixture();
    await f.ban("eve@example.test");
    for (const email of ["eve@example.test", "EVE@Example.test", "eve+again@example.test"]) {
      const response = await f.signUp(email);
      expect(response.status, email).toBe(403);
      expect(await response.json()).toMatchObject(refused);
    }
    expect(f.prisma.authData.user).toEqual([]);
    expect((await f.signUp("adam@example.test")).status).toBe(200);
    await f.unban("eve@example.test");
    expect((await f.signUp("eve@example.test")).status).toBe(200);
  });

  it("cannot sign up from a banned domain or its subdomains", async () => {
    const f = fixture();
    await f.ban("corp.test");
    expect((await f.signUp("eve@corp.test")).status).toBe(403);
    expect((await f.signUp("eve@mail.corp.test")).status).toBe(403);
    // A local part that is only a tag does not walk past the domain.
    expect((await f.signUp("+x@corp.test")).status).toBe(403);
    expect((await f.signUp("eve@notcorp.test")).status).toBe(200);
  });

  it("cannot sign up as the same mailbox under its other domain or with dots", async () => {
    const f = fixture();
    await f.ban("eve@gmail.com");
    expect((await f.signUp("e.ve@gmail.com")).status).toBe(403);
    expect((await f.signUp("eve@googlemail.com")).status).toBe(403);
    expect((await f.signUp("steve@gmail.com")).status).toBe(200);
  });

  it("cannot sign in, and loses the session it had, until the ban is lifted", async () => {
    const f = fixture();
    const signedUp = await f.signUp("eve@example.test");
    expect(signedUp.status).toBe(200);
    const cookie = (signedUp.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const session = async () =>
      (await f.auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.email ?? null;
    expect(await session()).toBe("eve@example.test");

    await f.ban("example.test");
    const response = await f.signIn("eve@example.test");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject(refused);
    expect(await session()).toBeNull();

    await f.unban("example.test");
    expect((await f.signIn("eve@example.test")).status).toBe(200);
    expect(await session()).toBe("eve@example.test");
  });
});
