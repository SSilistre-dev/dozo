import { createRouterClient, os } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type * as Db from "@rakazo/db";
import { accountDeactivated, recordSecurityEvent } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DozoAdminWiring } from "./dozo-admin.js";
import {
  DOZO_ADMIN_USERS_PAGE,
  dozoAdminRoutes,
  dozoAdminWiring,
  spendingLimitRoutes,
} from "./dozo-admin.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const stops = vi.hoisted(() => ({
  calls: [] as { actor: unknown; botId: string }[],
  fail: null as Error | null,
}));

// The app's own Stop is upstream's and has its own tests; here it only has to be reached, as
// the right person.
vi.mock("./routes/computer.js", () => ({
  computerRoutes: () => ({
    computer: {
      stop: os.$context<{ actor: Actor | null }>().handler(async ({ context, input }) => {
        if (stops.fail) throw stops.fail;
        stops.calls.push({ actor: context.actor, botId: (input as { botId: string }).botId });
        return {};
      }),
    },
  }),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  cancelDeactivatedAccountRuns: vi.fn(async () => 0),
  leaveInvitedSpaces: vi.fn(async () => []),
  recordSecurityEvent: vi.fn(async () => undefined),
}));

type User = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  createdAt: Date;
  deactivatedAt: Date | null;
};

function user(id: string, email: string, day: number, more: Partial<User> = {}): User {
  return {
    id,
    email,
    name: id,
    emailVerified: true,
    createdAt: new Date(Date.UTC(2026, 0, day)),
    deactivatedAt: null,
    ...more,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: a Prisma double reads loosely typed filters
type Where = any;

function world(users: User[]) {
  let sessions = [
    { userId: "admin", updatedAt: new Date("2026-03-01T00:00:00Z") },
    { userId: "ada", updatedAt: new Date("2026-03-02T00:00:00Z") },
    { userId: "ada", updatedAt: new Date("2026-03-05T00:00:00Z") },
  ];
  const computers = [
    { id: "pc-ada", userId: "ada", state: "running", kind: "docker", controlUserId: null },
    { id: "pc-old", userId: "gone", state: "running", kind: "docker", controlUserId: "bob" },
    { id: "pc-own", userId: "ada", state: "running", kind: "desktop", controlUserId: null },
    { id: "pc-off", userId: "ada", state: "stopped", kind: "docker", controlUserId: null },
    { id: "pc-x", userId: "nobody", state: "running", kind: "docker", controlUserId: null },
  ].map((computer, index) => ({
    ...computer,
    runningSince: new Date(Date.UTC(2026, 2, index + 1)),
  }));
  const bots = [
    { id: "bot-1", name: "Scout", userId: "ada", spaceId: "space-ada", computerId: "pc-ada" },
    { id: "bot-2", name: "Quill", userId: "ada", spaceId: "space-ada", computerId: "pc-ada" },
    { id: "bot-3", name: "Relic", userId: "gone", spaceId: "space-old", computerId: "pc-old" },
    { id: "bot-4", name: "Ghost", userId: "nobody", spaceId: "space-x", computerId: "pc-x" },
    { id: "bot-5", name: "Local", userId: "admin", spaceId: "space-admin", computerId: "pc-own" },
    { id: "bot-6", name: "Asleep", userId: "admin", spaceId: "space-admin", computerId: "pc-off" },
  ];
  const matches = (row: User, where: Where = {}) => {
    if (where.NOT && row.email.endsWith(where.NOT.email.endsWith)) return false;
    if (typeof where.id === "string" && row.id !== where.id) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.email && !row.email.toLowerCase().includes(where.email.contains.toLowerCase()))
      return false;
    if (where.deactivatedAt === null && row.deactivatedAt) return false;
    if (where.deactivatedAt?.not === null && !row.deactivatedAt) return false;
    return true;
  };
  // The ban list is the fork's own table, read and written with SQL.
  const bans = new Map<string, Date>();
  const hosted = (where: Where) =>
    computers.filter(
      (row) =>
        row.state === where.state &&
        !where.kind.notIn.includes(row.kind) &&
        (!where.userId || where.userId.in.includes(row.userId)),
    );
  const perUser = <T extends { userId: string }>(rows: T[]) =>
    [...new Set(rows.map((row) => row.userId))].map((userId) => ({
      userId,
      _count: { _all: rows.filter((row) => row.userId === userId).length },
      _max: {
        updatedAt: rows
          .filter((row) => row.userId === userId)
          .map((row) => (row as { updatedAt?: Date }).updatedAt)
          .sort((a, b) => Number(b) - Number(a))[0],
      },
    }));
  const prisma = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, keys: string[]) =>
      sql.join("").includes('"createdAt"')
        ? [...bans].map(([value, createdAt]) => ({ value, createdAt }))
        : keys.filter((key) => bans.has(key)).map((value) => ({ value })),
    ),
    $executeRaw: vi.fn(async (sql: TemplateStringsArray, value: string) => {
      if (!sql.join("").includes("INSERT")) bans.delete(value);
      else if (!bans.has(value)) bans.set(value, new Date("2026-04-01T00:00:00Z"));
      return 1;
    }),
    user: {
      findUnique: vi.fn(async ({ where }: Where) => users.find((row) => row.id === where.id)),
      findFirst: vi.fn(async ({ where }: Where) => users.find((row) => matches(row, where))),
      findMany: vi.fn(async ({ where, take, cursor }: Where) => {
        const rows = users
          .filter((row) => matches(row, where))
          .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
        const from = cursor ? rows.findIndex((row) => row.id === cursor.id) : 0;
        return from < 0 ? [] : rows.slice(from, take ? from + take : undefined);
      }),
      count: vi.fn(async ({ where }: Where) => users.filter((row) => matches(row, where)).length),
      updateMany: vi.fn(async ({ where, data }: Where) => {
        const rows = users.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
    },
    session: {
      groupBy: vi.fn(async ({ where }: Where) =>
        perUser(sessions.filter((row) => where.userId.in.includes(row.userId))),
      ),
      deleteMany: vi.fn(async ({ where }: Where) => {
        sessions = sessions.filter((row) => row.userId !== where.userId);
        return { count: 0 };
      }),
    },
    bot: {
      groupBy: vi.fn(async ({ where }: Where) =>
        perUser(bots.filter((row) => where.userId.in.includes(row.userId))),
      ),
      findFirst: vi.fn(async ({ where }: Where) => {
        const computer = hosted(where.computer).find((row) => row.id === where.computerId);
        const bot = bots.find((row) => row.computerId === where.computerId);
        return computer && bot && { ...bot, computer };
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    computer: {
      groupBy: vi.fn(async ({ where }: Where) => perUser(hosted(where))),
      count: vi.fn(async ({ where }: Where) => hosted(where).length),
      findMany: vi.fn(async ({ where }: Where) =>
        hosted(where).map((row) => ({
          ...row,
          bots: bots.filter((bot) => bot.computerId === row.id),
        })),
      ),
    },
    callPushDevice: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    messagingLinkCode: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    userDevice: { findMany: vi.fn(async () => []) },
  };
  return { prisma, sessions: () => sessions, bans };
}

const people = [
  user("admin", "Owner@Example.test", 1),
  user("squatter", "second@example.test", 2, { emailVerified: false }),
  user("ada", "ada@example.test", 3),
  user("bob", "bob@example.test", 4),
  user("chat", "tg-1@messaging.invalid", 5),
];

function setup(users: User[] = people.map((row) => ({ ...row })), wiring = true) {
  const { prisma, sessions, bans } = world(users);
  const removePush = vi.fn(async () => undefined);
  // The auth's own account deletion: the hooks the server sets, and the adapter that drops the rows.
  const steps: string[] = [];
  const step = (name: string) =>
    vi.fn(async (..._args: unknown[]): Promise<unknown> => void steps.push(name));
  const deletion = {
    steps,
    findUserById: vi.fn(async (id: string) => users.find((row) => row.id === id) ?? null),
    beforeDelete: step("content"),
    afterDelete: step("recorded"),
    deleteUser: vi.fn(async (id: string) => {
      steps.push("account");
      users.splice(
        users.findIndex((row) => row.id === id),
        1,
      );
    }),
    deleteUserSessions: step("sessions"),
  };
  const auth = {
    $context: Promise.resolve({
      internalAdapter: {
        findUserById: deletion.findUserById,
        deleteUser: deletion.deleteUser,
        deleteUserSessions: deletion.deleteUserSessions,
      },
    }),
    options: {
      user: {
        deleteUser: { beforeDelete: deletion.beforeDelete, afterDelete: deletion.afterDelete },
      },
    },
  };
  const deps = {
    prisma,
    pushTokens: { remove: removePush },
    events: { notify: vi.fn(), publishSpaceChange: vi.fn() },
    env: { adminEmails: ["owner@example.test", "second@example.test"] },
    ...(wiring
      ? dozoAdminWiring({
          devices: { prisma, devices: {} } as unknown as DozoAdminWiring["devices"],
          directoryProvisioning: false,
          signupsEnabled: "false",
          auth,
        })
      : {}),
  } as unknown as RouterDeps;
  const ctx = createRouterContext(deps);
  const as = (id: string) => {
    const row = users.find((candidate) => candidate.id === id);
    const actor = {
      userId: id,
      spaceId: `space-${id}`,
      email: row?.email ?? "",
      isDeploymentOwner: false,
    };
    return createRouterClient(dozoAdminRoutes(ctx), { context: { actor } }).dozoAdmin;
  };
  return { prisma, sessions, users, ctx, as, removePush, bans, deletion };
}

beforeEach(() => {
  vi.mocked(recordSecurityEvent).mockClear();
  stops.calls.length = 0;
  stops.fail = null;
});

describe("who may use the admin procedures", () => {
  it.each([
    ["an account that is not listed", "ada"],
    ["a listed address that is not verified", "squatter"],
  ])("refuses %s on every procedure, before anything is read", async (_who, id) => {
    const { as, prisma, users } = setup();
    const client = as(id);
    const refused = { code: "FORBIDDEN" };
    await expect(client.users({})).rejects.toMatchObject(refused);
    await expect(client.computers()).rejects.toMatchObject(refused);
    await expect(client.setSuspended({ userId: "bob", suspended: true })).rejects.toMatchObject(
      refused,
    );
    await expect(client.stopComputer({ computerId: "pc-ada" })).rejects.toMatchObject(refused);
    await expect(client.bans()).rejects.toMatchObject(refused);
    await expect(client.ban({ value: "bob@example.test" })).rejects.toMatchObject(refused);
    await expect(client.ban({ userId: "bob" })).rejects.toMatchObject(refused);
    await expect(client.unban({ value: "bob@example.test" })).rejects.toMatchObject(refused);
    await expect(client.deleteUser({ userId: "bob" })).rejects.toMatchObject(refused);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(users).toHaveLength(people.length);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.computer.findMany).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(stops.calls).toEqual([]);
    expect(users.every((row) => row.deactivatedAt === null)).toBe(true);
  });

  it("refuses a caller who is not signed in", async () => {
    const { ctx } = setup();
    const client = createRouterClient(dozoAdminRoutes(ctx), { context: { actor: null } });
    await expect(client.dozoAdmin.users({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("adds the admin procedures to the routes the router imports", () => {
    const routes = spendingLimitRoutes(setup().ctx);
    expect(Object.keys(routes)).toEqual(expect.arrayContaining(["spendingLimit", "dozoAdmin"]));
  });
});

describe("listing accounts", () => {
  it("lists people with their counts and nothing else, newest first", async () => {
    const { as } = setup();
    const result = await as("admin").users({});
    expect(result.signupsOpen).toBe(false);
    expect(result.total).toBe(4);
    expect(result.nextCursor).toBeNull();
    expect(result.users.map((row) => row.email)).toEqual([
      "bob@example.test",
      "ada@example.test",
      "second@example.test",
      "Owner@Example.test",
    ]);
    expect(result.users[1]).toEqual({
      id: "ada",
      email: "ada@example.test",
      name: "ada",
      createdAt: "2026-01-03T00:00:00.000Z",
      lastSeenAt: "2026-03-05T00:00:00.000Z",
      bots: 2,
      // Not the one on her own machine, nor the stopped one.
      runningComputers: 1,
      suspended: false,
      banned: false,
    });
    expect(result.users[0]).toMatchObject({ lastSeenAt: null, bots: 0, runningComputers: 0 });
  });

  it("returns one bounded page and continues from its cursor", async () => {
    const many = Array.from({ length: DOZO_ADMIN_USERS_PAGE + 5 }, (_, index) =>
      user(`u${index}`, `u${index}@example.test`, index + 10),
    );
    const { as, prisma } = setup([people[0] as User, ...many]);
    const first = await as("admin").users({});
    expect(first.users).toHaveLength(DOZO_ADMIN_USERS_PAGE);
    expect(first.total).toBe(DOZO_ADMIN_USERS_PAGE + 6);
    expect(prisma.user.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: DOZO_ADMIN_USERS_PAGE + 1 }),
    );
    const second = await as("admin").users({ cursor: first.nextCursor ?? undefined });
    expect(second.users).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    const seen = [...first.users, ...second.users].map((row) => row.id);
    expect(new Set(seen).size).toBe(DOZO_ADMIN_USERS_PAGE + 6);
  });

  it("searches by email, whatever the case", async () => {
    const { as } = setup();
    const result = await as("admin").users({ query: "  ADA@ " });
    expect(result.users.map((row) => row.id)).toEqual(["ada"]);
    expect(result.total).toBe(4);
    // Internal chat-app rows stay out even when the search names them.
    expect((await as("admin").users({ query: "messaging" })).users).toEqual([]);
  });

  it("reads the sign-up switch as open when the wiring is absent", async () => {
    expect((await setup(undefined, false).as("admin").users({})).signupsOpen).toBe(true);
  });
});

describe("suspending an account", () => {
  it("deactivates it and ends its sessions, and restores it", async () => {
    const { as, prisma, sessions, users, removePush } = setup();
    expect(await as("admin").setSuspended({ userId: "ada", suspended: true })).toEqual({
      suspended: true,
    });
    // What sign-in and every session lookup refuse on.
    expect(await accountDeactivated(prisma as never, "ada")).toBe(true);
    expect(sessions().some((row) => row.userId === "ada")).toBe(false);
    expect(sessions().some((row) => row.userId === "admin")).toBe(true);
    expect(removePush).toHaveBeenCalledWith("ada");
    expect((await as("admin").users({ query: "ada" })).users[0]).toMatchObject({
      suspended: true,
      lastSeenAt: null,
    });

    await as("admin").setSuspended({ userId: "ada", suspended: false });
    expect(users.find((row) => row.id === "ada")?.deactivatedAt).toBeNull();
  });

  it("refuses an admin suspending their own account, or another admin's", async () => {
    const { as, users } = setup();
    const second = users.find((row) => row.id === "squatter") as User;
    second.emailVerified = true;
    for (const userId of ["admin", "squatter"])
      await expect(as("admin").setSuspended({ userId, suspended: true })).rejects.toMatchObject({
        kind: "BAD_REQUEST",
      });
    expect(users.every((row) => row.deactivatedAt === null)).toBe(true);
  });

  it("refuses an account that does not exist, and an internal chat-app row", async () => {
    const { as, prisma } = setup();
    for (const userId of ["nobody", "chat"])
      await expect(as("admin").setSuspended({ userId, suspended: true })).rejects.toMatchObject({
        kind: "NOT_FOUND",
      });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("leaves a directory-managed account to its identity provider", async () => {
    const { prisma, ctx } = setup();
    Object.assign(ctx.deps, {
      dozoAdmin: { devices: {}, directoryProvisioning: true, signupsEnabled: undefined },
    });
    Object.assign(prisma, {
      scimUser: { findMany: vi.fn(async () => [{ active: true }]) },
      scimIdentityTombstone: { count: vi.fn(async () => 0) },
    });
    const actor = {
      userId: "admin",
      spaceId: "s",
      email: "owner@example.test",
      isDeploymentOwner: false,
    };
    const client = createRouterClient(dozoAdminRoutes(ctx), { context: { actor } }).dozoAdmin;
    await expect(client.setSuspended({ userId: "ada", suspended: true })).rejects.toMatchObject({
      kind: "CONFLICT",
    });
  });

  it("fails loudly when the server did not wire the routes", async () => {
    const { as } = setup(undefined, false);
    await expect(as("admin").setSuspended({ userId: "ada", suspended: true })).rejects.toThrow();
  });
});

describe("running computers", () => {
  it("lists the hosted ones with owner, bots and start", async () => {
    const { as } = setup();
    const result = await as("admin").computers();
    expect(result.total).toBe(3);
    expect(result.computers).toEqual([
      {
        id: "pc-ada",
        email: "ada@example.test",
        bots: ["Scout", "Quill"],
        runningSince: "2026-03-01T00:00:00.000Z",
      },
      { id: "pc-old", email: null, bots: ["Relic"], runningSince: "2026-03-02T00:00:00.000Z" },
      { id: "pc-x", email: null, bots: ["Ghost"], runningSince: "2026-03-05T00:00:00.000Z" },
    ]);
  });

  it("stops one through the app's own Stop, as the bot's owner", async () => {
    const { as } = setup();
    expect(await as("admin").stopComputer({ computerId: "pc-ada" })).toEqual({ ok: true });
    expect(stops.calls).toEqual([
      {
        botId: "bot-1",
        actor: {
          userId: "ada",
          spaceId: "space-ada",
          email: "ada@example.test",
          isDeploymentOwner: false,
        },
      },
    ]);
  });

  it("stops as the person holding the screen when the owner is not the one", async () => {
    const { as } = setup();
    await as("admin").stopComputer({ computerId: "pc-old" });
    expect(stops.calls[0]).toMatchObject({ botId: "bot-3", actor: { userId: "bob" } });
  });

  it("passes on the app's refusal", async () => {
    const { as } = setup();
    stops.fail = new Error("Computer is busy");
    await expect(as("admin").stopComputer({ computerId: "pc-ada" })).rejects.toThrow();
  });

  it("answers not found for a computer the page does not list, or with nobody to act as", async () => {
    const { as } = setup();
    // Unknown, on a person's own machine, not running, and one whose owner is gone.
    for (const computerId of ["pc-none", "pc-own", "pc-off", "pc-x"])
      await expect(as("admin").stopComputer({ computerId })).rejects.toMatchObject({
        kind: "NOT_FOUND",
      });
    expect(stops.calls).toEqual([]);
  });
});

describe("the ban list", () => {
  it("stores an address or a domain in one form, lists it and lifts it", async () => {
    const { as } = setup();
    const admin = as("admin");
    expect(await admin.ban({ value: "  Spam+promo@Mail.Example.NET " })).toEqual({
      value: "spam@mail.example.net",
    });
    expect(await admin.ban({ value: "*.Evil.TEST" })).toEqual({ value: "evil.test" });
    // The same entry again changes nothing.
    await admin.ban({ value: "spam+other@mail.example.net" });
    expect((await admin.bans()).bans).toEqual([
      { value: "spam@mail.example.net", createdAt: "2026-04-01T00:00:00.000Z" },
      { value: "evil.test", createdAt: "2026-04-01T00:00:00.000Z" },
    ]);
    // Lifted in whatever spelling it is named.
    expect(await admin.unban({ value: " *.EVIL.test" })).toEqual({ ok: true });
    expect((await admin.bans()).bans.map((ban) => ban.value)).toEqual(["spam@mail.example.net"]);
    // Each change is on record with the admin who made it.
    const change = (change: string, entry: string) => ({
      type: "deployment.settings.changed",
      userId: "admin",
      metadata: { setting: "ban_list", change, entry },
    });
    expect(vi.mocked(recordSecurityEvent).mock.calls.map(([event]) => event)).toEqual([
      change("added", "spam@mail.example.net"),
      change("added", "evil.test"),
      change("added", "spam@mail.example.net"),
      change("removed", "evil.test"),
    ]);
  });

  it("refuses what is neither an address nor a domain", async () => {
    const { as, bans } = setup();
    for (const value of ["", "nonsense", "a b@example.test", "test", "x@localhost", "a@@b.test"])
      await expect(as("admin").ban({ value }), value).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    expect(bans.size).toBe(0);
  });

  it("refuses an entry that would lock an admin out", async () => {
    const { as, bans, users } = setup();
    for (const input of [
      { value: "OWNER+x@example.test" },
      { value: "example.test" },
      { userId: "admin" },
      // Listed as an admin, verified or not.
      { userId: "squatter" },
    ])
      await expect(as("admin").ban(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "An admin account cannot be banned",
      });
    expect(bans.size).toBe(0);
    expect(users.every((row) => row.deactivatedAt === null)).toBe(true);
  });

  it("bans an account: suspends it and lists its address", async () => {
    const users = [...people.map((row) => ({ ...row })), user("eve", "Eve+tag@Corp.test", 6)];
    const { as, prisma, sessions } = setup(users);
    sessions().push({ userId: "eve", updatedAt: new Date("2026-03-03T00:00:00Z") });
    expect(await as("admin").ban({ userId: "eve" })).toEqual({ value: "eve@corp.test" });
    expect(await accountDeactivated(prisma as never, "eve")).toBe(true);
    expect(sessions().some((row) => row.userId === "eve")).toBe(false);
    expect((await as("admin").users({ query: "eve" })).users[0]).toMatchObject({
      suspended: true,
      banned: true,
    });
    // Lifting the entry leaves the suspension, which is restored on its own.
    await as("admin").unban({ value: "eve@corp.test" });
    expect((await as("admin").users({ query: "eve" })).users[0]).toMatchObject({
      suspended: true,
      banned: false,
    });
  });

  it("marks every account a banned domain covers, subdomains included", async () => {
    const users = [
      ...people.map((row) => ({ ...row })),
      user("eve", "eve@corp.test", 6),
      user("mal", "mal@mail.corp.test", 7),
      user("ann", "ann@notcorp.test", 8),
    ];
    const { as } = setup(users);
    await as("admin").ban({ value: "corp.test" });
    const listed = (await as("admin").users({})).users;
    expect(listed.filter((row) => row.banned).map((row) => row.id)).toEqual(["mal", "eve"]);
    // A list entry alone suspends nobody.
    expect(listed.some((row) => row.suspended)).toBe(false);
  });

  it("lists nothing when the account cannot be suspended", async () => {
    const { as, bans } = setup();
    await expect(as("admin").ban({ userId: "nobody" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(as("admin").ban({ userId: "chat" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(setup(undefined, false).as("admin").ban({ userId: "bob" })).rejects.toThrow(
      /wiring/,
    );
    expect(bans.size).toBe(0);
  });
});

describe("deleting an account", () => {
  it("suspends it, then runs the account's own deletion in its order", async () => {
    const { as, users, deletion, sessions } = setup();
    const ada = users.find((row) => row.id === "ada");
    deletion.beforeDelete.mockImplementationOnce(async () => {
      // Its content goes while it can no longer sign in or act.
      expect(ada?.deactivatedAt).toBeInstanceOf(Date);
      expect(sessions().some((row) => row.userId === "ada")).toBe(false);
      // On record, with the admin, before anything of the account is gone.
      expect(recordSecurityEvent).toHaveBeenLastCalledWith({
        type: "auth.account.deactivated",
        userId: "ada",
        metadata: { by: "operator", admin: "admin", reason: "deletion" },
      });
      deletion.steps.push("content");
    });
    expect(await as("admin").deleteUser({ userId: "ada" })).toEqual({ ok: true });
    expect(deletion.steps).toEqual(["content", "account", "sessions", "recorded"]);
    expect(deletion.beforeDelete).toHaveBeenCalledExactlyOnceWith(ada);
    expect(deletion.afterDelete).toHaveBeenCalledExactlyOnceWith(ada);
    expect(users.some((row) => row.id === "ada")).toBe(false);
  });

  it("keeps the account when its content could not be deleted", async () => {
    const { as, users, deletion } = setup();
    deletion.beforeDelete.mockRejectedValueOnce(new Error("provider down"));
    await expect(as("admin").deleteUser({ userId: "ada" })).rejects.toThrow("provider down");
    expect(deletion.deleteUser).not.toHaveBeenCalled();
    // Suspended, so deleting again resumes.
    expect(users.find((row) => row.id === "ada")?.deactivatedAt).toBeInstanceOf(Date);
    expect(await as("admin").deleteUser({ userId: "ada" })).toEqual({ ok: true });
  });

  it("refuses an admin deleting their own account, or another admin's", async () => {
    const { as, users, deletion } = setup();
    (users.find((row) => row.id === "squatter") as User).emailVerified = true;
    for (const userId of ["admin", "squatter"])
      await expect(as("admin").deleteUser({ userId })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "An admin account cannot be deleted",
      });
    expect(deletion.steps).toEqual([]);
    expect(users.every((row) => row.deactivatedAt === null)).toBe(true);
  });

  it("answers not found for an unknown account, a chat contact, or one gone meanwhile", async () => {
    const { as, deletion } = setup();
    // Gone between the page's lookup and the auth's.
    deletion.findUserById.mockResolvedValueOnce(null);
    for (const userId of ["nobody", "chat", "bob"])
      await expect(as("admin").deleteUser({ userId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    expect(deletion.steps).toEqual([]);
  });

  it("is refused without the server's wiring", async () => {
    await expect(setup(undefined, false).as("admin").deleteUser({ userId: "bob" })).rejects.toThrow(
      /wiring/,
    );
  });
});
