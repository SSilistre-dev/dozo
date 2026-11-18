import { createRouterClient, os } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type * as Db from "@rakazo/db";
import { accountDeactivated } from "@rakazo/db";
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
const audit = vi.hoisted(() => ({ events: [] as Record<string, unknown>[] }));

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
  // The audit primitive has its own tests; here it only has to be asked, with the right facts.
  recordAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
  }),
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

type Subscription = { status: string; byokTier: string | null };
type Grant = { tier: string; endsAt: Date; grantedById: string | null; note: string | null };

function world(users: User[]) {
  // Everyone owns an organization of their own, except Bob, who has none.
  const memberships = users
    .filter((row) => row.id !== "bob")
    .map((row) => ({ userId: row.id, organizationId: `org-${row.id}`, role: "owner" }));
  const organizations = new Map<string, { billing: Subscription | null; grant: Grant | null }>();
  for (const membership of memberships)
    organizations.set(membership.organizationId, { billing: null, grant: null });
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
    member: {
      findMany: vi.fn(async ({ where }: Where) =>
        memberships.filter((row) => row.userId === where.userId),
      ),
    },
    organization: {
      findMany: vi.fn(async ({ where }: Where) =>
        [...organizations]
          .filter(([id]) => where.id.in.includes(id))
          .map(([id, { billing, grant }]) => ({
            id,
            billing,
            dozoPlanGrant: grant && { tier: grant.tier, endsAt: grant.endsAt },
          })),
      ),
    },
    dozoPlanGrant: {
      upsert: vi.fn(async ({ where, update }: Where) => {
        const row = organizations.get(where.organizationId);
        if (row) row.grant = { ...update };
      }),
      deleteMany: vi.fn(async ({ where }: Where) => {
        const row = organizations.get(where.organizationId);
        const count = row?.grant ? 1 : 0;
        if (row) row.grant = null;
        return { count };
      }),
    },
    user: {
      findFirst: vi.fn(async ({ where }: Where) => users.find((row) => matches(row, where))),
      findUnique: vi.fn(async ({ where }: Where) => users.find((row) => row.id === where.id)),
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
  return { prisma, sessions: () => sessions, organizations };
}

const people = [
  user("admin", "Owner@Example.test", 1),
  user("squatter", "second@example.test", 2, { emailVerified: false }),
  user("ada", "ada@example.test", 3),
  user("bob", "bob@example.test", 4),
  user("chat", "tg-1@messaging.invalid", 5),
];

function setup(users: User[] = people.map((row) => ({ ...row })), wiring = true) {
  const { prisma, sessions, organizations } = world(users);
  const removePush = vi.fn(async () => undefined);
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
  return { prisma, sessions, users, ctx, as, removePush, organizations };
}

beforeEach(() => {
  stops.calls.length = 0;
  stops.fail = null;
  audit.events.length = 0;
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
    await expect(
      client.setPlan({ userId: "bob", tier: "max", endsAt: "2999-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject(refused);
    await expect(client.setPlan({ userId: "ada", tier: null })).rejects.toMatchObject(refused);
    expect(prisma.dozoPlanGrant.upsert).not.toHaveBeenCalled();
    expect(prisma.dozoPlanGrant.deleteMany).not.toHaveBeenCalled();
    expect(prisma.organization.findMany).not.toHaveBeenCalled();
    expect(audit.events).toEqual([]);
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
      plan: { tier: "standard", grantedUntil: null },
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

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY);

describe("the plan in the list", () => {
  const plan = async (as: ReturnType<typeof setup>["as"], query: string) =>
    (await as("admin").users({ query })).users[0]?.plan;

  it("is Free for everyone by default, and for an account with no organization of its own", async () => {
    const { as } = setup();
    expect(await plan(as, "ada")).toEqual({ tier: "standard", grantedUntil: null });
    expect(await plan(as, "bob")).toEqual({ tier: "standard", grantedUntil: null });
  });

  it("is the subscription's tier while it is live", async () => {
    const { as, organizations } = setup();
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    row.billing = { status: "active", byokTier: "pro" };
    expect(await plan(as, "ada")).toEqual({ tier: "pro", grantedUntil: null });
    row.billing = { status: "canceled", byokTier: "pro" };
    expect(await plan(as, "ada")).toEqual({ tier: "standard", grantedUntil: null });
    row.billing = { status: "active", byokTier: null };
    expect(await plan(as, "ada")).toEqual({ tier: "standard", grantedUntil: null });
  });

  it("is the higher of the subscription and an unexpired grant, with the grant's end", async () => {
    const { as, organizations } = setup();
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    const endsAt = inDays(5);
    row.grant = { tier: "max", endsAt, grantedById: "admin", note: null };
    expect(await plan(as, "ada")).toEqual({ tier: "max", grantedUntil: endsAt.toISOString() });
    row.billing = { status: "active", byokTier: "pro" };
    expect(await plan(as, "ada")).toEqual({ tier: "max", grantedUntil: endsAt.toISOString() });
    row.grant = { tier: "pro", endsAt, grantedById: "admin", note: null };
    row.billing = { status: "active", byokTier: "max" };
    expect(await plan(as, "ada")).toEqual({ tier: "max", grantedUntil: endsAt.toISOString() });
  });

  it("drops a grant that has ended", async () => {
    const { as, organizations } = setup();
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    row.grant = { tier: "max", endsAt: inDays(-1), grantedById: "admin", note: null };
    expect(await plan(as, "ada")).toEqual({ tier: "standard", grantedUntil: null });
  });
});

describe("giving a plan by hand", () => {
  const until = (days: number) => inDays(days).toISOString();

  it("sets, replaces and ends the grant of the account's own organization, with an audit record each time", async () => {
    const { as, organizations } = setup();
    const first = until(30);
    expect(
      await as("admin").setPlan({ userId: "ada", tier: "pro", endsAt: first, note: "press" }),
    ).toEqual({ plan: { tier: "pro", grantedUntil: first } });
    expect(organizations.get("org-ada")?.grant).toEqual({
      tier: "pro",
      endsAt: new Date(first),
      grantedById: "admin",
      note: "press",
    });

    const second = until(60);
    expect(await as("admin").setPlan({ userId: "ada", tier: "max", endsAt: second })).toEqual({
      plan: { tier: "max", grantedUntil: second },
    });
    expect(organizations.get("org-ada")?.grant).toMatchObject({
      tier: "max",
      endsAt: new Date(second),
      note: null,
    });

    expect(await as("admin").setPlan({ userId: "ada", tier: null })).toEqual({
      plan: { tier: "standard", grantedUntil: null },
    });
    expect(organizations.get("org-ada")?.grant).toBeNull();
    // Nobody else's organization was touched.
    expect(organizations.get("org-admin")?.grant).toBeNull();

    // Tenant-visible: neither the admin's email or id, nor the note.
    expect(JSON.stringify(audit.events)).not.toMatch(/press|owner@example|"admin"/);
    expect(audit.events).toEqual([
      {
        action: "plan.granted",
        actor: { type: "system", label: "Operator" },
        organizationId: "org-ada",
        target: { type: "user", id: "ada" },
        metadata: { tier: "pro", endsAt: first },
      },
      {
        action: "plan.granted",
        actor: { type: "system", label: "Operator" },
        organizationId: "org-ada",
        target: { type: "user", id: "ada" },
        metadata: { tier: "max", endsAt: second },
      },
      {
        action: "plan.grant_ended",
        actor: { type: "system", label: "Operator" },
        organizationId: "org-ada",
        target: { type: "user", id: "ada" },
        metadata: { tier: null, endsAt: null },
      },
    ]);
  });

  it("leaves a subscription alone and answers with the higher plan", async () => {
    const { as, organizations } = setup();
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    row.billing = { status: "active", byokTier: "max" };
    const endsAt = until(10);
    expect(await as("admin").setPlan({ userId: "ada", tier: "pro", endsAt })).toEqual({
      plan: { tier: "max", grantedUntil: endsAt },
    });
    expect(row.billing).toEqual({ status: "active", byokTier: "max" });
  });

  it("answers and audits an end of a grant that was not there", async () => {
    const { as } = setup();
    expect(await as("admin").setPlan({ userId: "ada", tier: null })).toEqual({
      plan: { tier: "standard", grantedUntil: null },
    });
    expect(audit.events).toHaveLength(1);
  });

  it("lets an admin give themselves a plan", async () => {
    const { as, organizations } = setup();
    await as("admin").setPlan({ userId: "admin", tier: "pro", endsAt: until(2) });
    expect(organizations.get("org-admin")?.grant).toMatchObject({ tier: "pro" });
  });

  it("refuses an end date that is missing, past, or too far ahead, and writes nothing", async () => {
    const { as, prisma } = setup();
    const refused = { kind: "BAD_REQUEST" };
    await expect(as("admin").setPlan({ userId: "ada", tier: "pro" })).rejects.toMatchObject(
      refused,
    );
    for (const endsAt of [until(-1), new Date(Date.now() - 1000).toISOString(), until(5 * 366 + 1)])
      await expect(
        as("admin").setPlan({ userId: "ada", tier: "max", endsAt }),
      ).rejects.toMatchObject(refused);
    expect(prisma.dozoPlanGrant.upsert).not.toHaveBeenCalled();
    expect(audit.events).toEqual([]);
    // Five years ahead is allowed.
    await expect(
      as("admin").setPlan({ userId: "ada", tier: "max", endsAt: until(5 * 365) }),
    ).resolves.toMatchObject({ plan: { tier: "max" } });
  });

  it("refuses a tier that is not one an admin can give", async () => {
    const { as, prisma } = setup();
    await expect(
      as("admin").setPlan({ userId: "ada", tier: "standard" as never, endsAt: until(2) }),
    ).rejects.toThrow();
    expect(prisma.dozoPlanGrant.upsert).not.toHaveBeenCalled();
  });

  it("answers not found for an unknown account, a chat-app row, and an account without an organization", async () => {
    const { as, prisma } = setup();
    for (const userId of ["nobody", "chat", "bob"])
      await expect(
        as("admin").setPlan({ userId, tier: "pro", endsAt: until(2) }),
      ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect(prisma.dozoPlanGrant.upsert).not.toHaveBeenCalled();
    expect(audit.events).toEqual([]);
  });

  it("fails loudly, and writes no audit record, when the grant cannot be written", async () => {
    const { as, prisma } = setup();
    prisma.dozoPlanGrant.upsert.mockRejectedValueOnce(new Error("database down"));
    await expect(
      as("admin").setPlan({ userId: "ada", tier: "pro", endsAt: until(2) }),
    ).rejects.toThrow();
    expect(audit.events).toEqual([]);
  });

  it("passes on a failure that is not an account without an organization", async () => {
    const { as, prisma } = setup();
    prisma.member.findMany.mockRejectedValueOnce(new Error("database down"));
    await expect(
      as("admin").setPlan({ userId: "ada", tier: "pro", endsAt: until(2) }),
    ).rejects.toThrow("database down");
    prisma.member.findMany.mockRejectedValueOnce(new Error("database down"));
    await expect(as("admin").users({})).rejects.toThrow("database down");
  });
});
