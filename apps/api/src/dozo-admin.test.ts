import { createRouterClient, os } from "@orpc/server";
import type * as Adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type * as Db from "@rakazo/db";
import {
  accountDeactivated,
  hasBillingAccess,
  IsolationError,
  ownedOrganizationId,
  recordSecurityEvent,
} from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DozoAdminWiring } from "./dozo-admin.js";
import {
  DOZO_ADMIN_USERS_PAGE,
  dozoAdminRoutes,
  dozoAdminWiring,
  spendingLimitRoutes,
} from "./dozo-admin.js";
import { LIVE_BILLING_STATUSES, ownedOrganizations } from "./dozo-admin-members.js";
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
// A provider that declares a memory read, standing in for the Docker host's.
const host = vi.hoisted(() => ({ memory: vi.fn() }));
vi.mock("@rakazo/adapters", async (original) => {
  const real = await original<typeof Adapters>();
  return {
    ...real,
    sandboxKindCapabilities: (kind: string | null | undefined) =>
      kind === "memory-host" ? { memory: host.memory } : real.sandboxKindCapabilities(kind),
  };
});
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

type Subscription = {
  status: string;
  byokTier: string | null;
  trialEndsAt?: Date | null;
  currentPeriodEndsAt?: Date | null;
  cancelAtPeriodEnd?: boolean;
};
type Grant = { tier: string; endsAt: Date; grantedById: string | null; note: string | null };

function world(users: User[]) {
  // Everyone owns an organization of their own, except Bob, who has none.
  const memberships = users
    .filter((row) => row.id !== "bob")
    .map((row) => ({ userId: row.id, organizationId: `org-${row.id}`, role: "owner" }));
  const organizations = new Map<
    string,
    { billing: Subscription | null; grant: Grant | null; freeUntil?: Date | null }
  >();
  for (const membership of memberships)
    organizations.set(membership.organizationId, { billing: null, grant: null });
  const organization = (id: string) => {
    const row = organizations.get(id);
    return (
      row && {
        id,
        billing: row.billing && {
          trialEndsAt: null,
          currentPeriodEndsAt: null,
          cancelAtPeriodEnd: false,
          ...row.billing,
        },
        dozoPlanGrant: row.grant && { tier: row.grant.tier, endsAt: row.grant.endsAt },
        modelCredits: row.freeUntil === undefined ? null : { byokFreeUntil: row.freeUntil },
      }
    );
  };
  let sessions = [
    {
      id: "s-1",
      userId: "admin",
      createdAt: new Date("2026-02-01T00:00:00Z"),
      updatedAt: new Date("2026-03-01T00:00:00Z"),
      userAgent: null as string | null,
    },
    {
      id: "s-2",
      userId: "ada",
      createdAt: new Date("2026-02-02T00:00:00Z"),
      updatedAt: new Date("2026-03-02T00:00:00Z"),
      userAgent: "Phone",
    },
    {
      id: "s-3",
      userId: "ada",
      createdAt: new Date("2026-02-03T00:00:00Z"),
      updatedAt: new Date("2026-03-05T00:00:00Z"),
      userAgent: null,
    },
  ];
  // Everyone's own Space, and Ada invited into the admin's.
  const spaces = [
    ...memberships.map((row) => ({
      userId: row.userId,
      space: { id: `space-${row.userId}`, name: "Home", organizationId: row.organizationId },
    })),
    {
      userId: "ada",
      space: { id: "space-admin", name: "Team", organizationId: "org-admin" },
    },
  ];
  const settings = { modelCreditsEnabled: false };
  // Ada's computer, paired through her sign-in.
  const devices: { id: string; userId: string; revokedAt: Date | null }[] = [
    { id: "device-ada", userId: "ada", revokedAt: null },
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
  // Every fixture organization is live, so the live condition always holds.
  const organizationMatches = (id: string, where: Where): boolean => {
    const row = organizations.get(id);
    if (!row) return false;
    if (where.AND) return where.AND.every((part: Where) => organizationMatches(id, part));
    if (where.OR) return where.OR.some((part: Where) => organizationMatches(id, part));
    if (where.billing)
      return (
        row.billing !== null &&
        where.billing.status.in.includes(row.billing.status) &&
        where.billing.byokTier.in.includes(row.billing.byokTier)
      );
    if (where.dozoPlanGrant)
      return (
        row.grant !== null &&
        where.dozoPlanGrant.tier.in.includes(row.grant.tier) &&
        row.grant.endsAt > where.dozoPlanGrant.endsAt.gt
      );
    return true;
  };
  const matches = (row: User, where: Where = {}): boolean => {
    if (where.NOT && matches(row, where.NOT)) return false;
    if (where.AND && !where.AND.every((part: Where) => matches(row, part))) return false;
    if (where.members) {
      const { role, organization } = where.members.some;
      const owns = memberships.some(
        (membership) =>
          membership.userId === row.id &&
          membership.role.includes(role.contains) &&
          organizationMatches(membership.organizationId, organization),
      );
      if (!owns) return false;
    }
    if (typeof where.id === "string" && row.id !== where.id) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.email?.endsWith && !row.email.endsWith(where.email.endsWith)) return false;
    if (
      where.email?.contains &&
      !row.email.toLowerCase().includes(where.email.contains.toLowerCase())
    )
      return false;
    if (where.deactivatedAt === null && row.deactivatedAt) return false;
    if (where.deactivatedAt?.not === null && !row.deactivatedAt) return false;
    return true;
  };
  // The ban list is the fork's own table, read and written with SQL.
  const bans = new Map<string, Date>();
  // The site settings' one row, once an admin saved one.
  const site: Record<string, unknown>[] = [];
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
    // One transaction is the same fake: what it writes is visible at once.
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
    member: {
      findMany: vi.fn(async ({ where }: Where) =>
        memberships.filter((row) =>
          where.userId?.in
            ? where.userId.in.includes(row.userId)
            : where.organizationId?.in
              ? where.organizationId.in.includes(row.organizationId)
              : row.userId === where.userId,
        ),
      ),
    },
    organization: {
      findMany: vi.fn(async ({ where }: Where) =>
        [...organizations]
          .filter(([id]) => where.id.in.includes(id))
          .map(([id]) => organization(id)),
      ),
      findUnique: vi.fn(async ({ where }: Where) => organization(where.id) ?? null),
    },
    deploymentSettings: { findUnique: vi.fn(async () => settings) },
    // No admin set a plan quota: the plans hold their terms.
    dozoPlanQuota: { findMany: vi.fn(async () => []) },
    spaceMember: {
      findMany: vi.fn(async ({ where }: Where) =>
        spaces.filter((row) => row.userId === where.userId).map(({ space }) => ({ space })),
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
    $queryRaw: vi.fn(async (sql: TemplateStringsArray | { sql: string }, keys: string[]) => {
      // The files an organization keeps are summed with a query object, not a template.
      if ("sql" in sql) return [{ used: String(3 * 1024 * 1024) }];
      if (sql.join("").includes("dozo_site_settings")) return site;
      return sql.join("").includes('"createdAt"')
        ? [...bans].map(([value, createdAt]) => ({ value, createdAt }))
        : keys.filter((key) => bans.has(key)).map((value) => ({ value }));
    }),
    $executeRaw: vi.fn(async (sql: TemplateStringsArray, value: string) => {
      if (!sql.join("").includes("INSERT")) bans.delete(value);
      else if (!bans.has(value)) bans.set(value, new Date("2026-04-01T00:00:00Z"));
      return 1;
    }),
    user: {
      findUnique: vi.fn(async ({ where }: Where) => users.find((row) => row.id === where.id)),
      findFirst: vi.fn(async ({ where }: Where) => users.find((row) => matches(row, where))),
      findMany: vi.fn(async ({ where, take, cursor, orderBy }: Where) => {
        const order: Record<string, "asc" | "desc">[] = orderBy ?? [{ createdAt: "desc" }];
        const rows = users
          .filter((row) => matches(row, where))
          .sort((a, b) => {
            for (const entry of order) {
              const [field, direction] = Object.entries(entry)[0] as [keyof User, string];
              const key = (value: User[keyof User]) =>
                value instanceof Date ? Number(value) : String(value);
              const [x, y] = [key(a[field]), key(b[field])];
              if (x !== y) return (x < y ? -1 : 1) * (direction === "asc" ? 1 : -1);
            }
            return 0;
          });
        const from = cursor ? rows.findIndex((row) => row.id === cursor.id) : 0;
        return from < 0 ? [] : rows.slice(from, take ? from + take : undefined);
      }),
      count: vi.fn(async ({ where }: Where) => users.filter((row) => matches(row, where)).length),
      update: vi.fn(async ({ where, data }: Where) =>
        Object.assign(users.find((row) => row.id === where.id) as User, data),
      ),
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
      findMany: vi.fn(async ({ where, take }: Where) =>
        sessions
          .filter((row) => row.userId === where.userId)
          .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
          .slice(0, take),
      ),
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
      findMany: vi.fn(async ({ where }: Where) =>
        bots.filter((row) => row.userId === where.userId).map(({ id, name }) => ({ id, name })),
      ),
    },
    computer: {
      groupBy: vi.fn(async ({ where }: Where) => perUser(hosted(where))),
      count: vi.fn(async ({ where }: Where) => hosted(where).length),
      // The running hosted ones for the list, or every one an account has for its page.
      findMany: vi.fn(async ({ where }: Where) =>
        (where.state ? hosted(where) : computers.filter((row) => row.userId === where.userId)).map(
          (row) => ({ ...row, bots: bots.filter((bot) => bot.computerId === row.id) }),
        ),
      ),
    },
    callPushDevice: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    messagingLinkCode: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    userDevice: {
      findMany: vi.fn(async ({ where }: Where) =>
        devices.filter((row) => row.userId === where.userId && !row.revokedAt),
      ),
      updateMany: vi.fn(async ({ where, data }: Where) => {
        const rows = devices.filter((row) => row.id === where.id && !row.revokedAt);
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
    },
  };
  return {
    prisma,
    sessions: () => sessions,
    organizations,
    bans,
    site,
    memberships,
    settings,
    computers,
    devices,
  };
}

const people = [
  user("admin", "Owner@Example.test", 1),
  user("squatter", "second@example.test", 2, { emailVerified: false }),
  user("ada", "ada@example.test", 3),
  user("bob", "bob@example.test", 4),
  user("chat", "tg-1@messaging.invalid", 5),
];

function setup(
  users: User[] = people.map((row) => ({ ...row })),
  wiring = true,
  sandboxId?: string,
) {
  const { prisma, sessions, organizations, bans, site, memberships, settings, computers, devices } =
    world(users);
  const disconnect = vi.fn(async () => undefined);
  const planChanged = vi.fn(async (_tx: unknown, _organizationId: string) => undefined);
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
    ...(sandboxId ? { sandbox: { describe: () => ({ id: sandboxId }) } } : {}),
    ...(wiring
      ? dozoAdminWiring({
          devices: { prisma, devices: { disconnect } } as unknown as DozoAdminWiring["devices"],
          directoryProvisioning: false,
          signupsEnabled: "false",
          auth,
          planChanged,
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
  return {
    planChanged,
    prisma,
    sessions,
    users,
    ctx,
    as,
    removePush,
    organizations,
    bans,
    site,
    deletion,
    memberships,
    settings,
    computers,
    devices,
    disconnect,
  };
}

beforeEach(() => {
  vi.mocked(recordSecurityEvent).mockClear();
  stops.calls.length = 0;
  stops.fail = null;
  host.memory.mockReset();
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
    await expect(client.bans()).rejects.toMatchObject(refused);
    await expect(client.ban({ value: "bob@example.test" })).rejects.toMatchObject(refused);
    await expect(client.ban({ userId: "bob" })).rejects.toMatchObject(refused);
    await expect(client.unban({ value: "bob@example.test" })).rejects.toMatchObject(refused);
    await expect(client.deleteUser({ userId: "bob" })).rejects.toMatchObject(refused);
    await expect(client.user({ userId: "bob" })).rejects.toMatchObject(refused);
    await expect(client.rename({ userId: "bob", name: "Robert" })).rejects.toMatchObject(refused);
    await expect(client.endSessions({ userId: "ada" })).rejects.toMatchObject(refused);
    await expect(client.users({ plan: "max" })).rejects.toMatchObject(refused);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
    expect(prisma.session.findMany).not.toHaveBeenCalled();
    expect(prisma.member.findMany).not.toHaveBeenCalled();
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
      plan: { tier: "standard", grantedUntil: null, ends: null },
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

  it("reads the sign-up switch an admin set over the environment's", async () => {
    const { as, site } = setup();
    site.push({ signupsOpen: true });
    expect((await as("admin").users({})).signupsOpen).toBe(true);
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

  it("adds the memory the computers hold where the provider declares a total", async () => {
    host.memory.mockResolvedValue({ usedGb: 1.5, totalGb: 6 });
    const { as } = setup(undefined, true, "memory-host");
    expect((await as("admin").computers()).memory).toEqual({ usedGb: 1.5, totalGb: 6 });
  });

  it("leaves memory out when no total is set or the provider has no such read", async () => {
    host.memory.mockResolvedValue(undefined);
    const none = await setup(undefined, true, "memory-host").as("admin").computers();
    expect(none).not.toHaveProperty("memory");
    expect(none.total).toBe(3);
    const other = await setup().as("admin").computers();
    expect(other).not.toHaveProperty("memory");
    expect(host.memory).toHaveBeenCalledTimes(1);
  });

  it("still lists the computers when the memory read fails", async () => {
    host.memory.mockRejectedValue(new Error("supervisor unreachable"));
    const result = await setup(undefined, true, "memory-host").as("admin").computers();
    expect(result).not.toHaveProperty("memory");
    expect(result.computers).toHaveLength(3);
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
/** What the list says of a grant in force that ends at `at`. */
const granted = (at: Date | string) => ({
  source: "granted",
  at: new Date(at).toISOString(),
  renews: false,
});

describe("the plan in the list", () => {
  const plan = async (as: ReturnType<typeof setup>["as"], query: string) =>
    (await as("admin").users({ query })).users[0]?.plan;

  it("is Free for everyone by default, and for an account with no organization of its own", async () => {
    const { as } = setup();
    expect(await plan(as, "ada")).toEqual({ tier: "standard", grantedUntil: null, ends: null });
    expect(await plan(as, "bob")).toEqual({ tier: "standard", grantedUntil: null, ends: null });
  });

  it("is the subscription's tier while it is live", async () => {
    const { as, organizations } = setup();
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    row.billing = { status: "active", byokTier: "pro" };
    expect(await plan(as, "ada")).toEqual({ tier: "pro", grantedUntil: null, ends: null });
    row.billing = { status: "canceled", byokTier: "pro" };
    expect(await plan(as, "ada")).toEqual({ tier: "standard", grantedUntil: null, ends: null });
    row.billing = { status: "active", byokTier: null };
    expect(await plan(as, "ada")).toEqual({ tier: "standard", grantedUntil: null, ends: null });
  });

  it("is the higher of the subscription and an unexpired grant, with the grant's end", async () => {
    const { as, organizations } = setup();
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    const endsAt = inDays(5);
    row.grant = { tier: "max", endsAt, grantedById: "admin", note: null };
    expect(await plan(as, "ada")).toEqual({
      tier: "max",
      grantedUntil: endsAt.toISOString(),
      ends: granted(endsAt),
    });
    row.billing = { status: "active", byokTier: "pro" };
    expect(await plan(as, "ada")).toEqual({
      tier: "max",
      grantedUntil: endsAt.toISOString(),
      ends: { ...granted(endsAt), fallsTo: { from: "Premium Plus", to: "Premium" } },
    });
    row.grant = { tier: "pro", endsAt, grantedById: "admin", note: null };
    row.billing = { status: "active", byokTier: "max" };
    expect(await plan(as, "ada")).toEqual({
      tier: "max",
      grantedUntil: endsAt.toISOString(),
      ends: null,
    });
  });

  it("drops a grant that has ended", async () => {
    const { as, organizations } = setup();
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    row.grant = { tier: "max", endsAt: inDays(-1), grantedById: "admin", note: null };
    expect(await plan(as, "ada")).toEqual({ tier: "standard", grantedUntil: null, ends: null });
  });
});

describe("giving a plan by hand", () => {
  const until = (days: number) => inDays(days).toISOString();

  it("sets, replaces and ends the grant of the account's own organization, with an audit record each time", async () => {
    const { as, organizations } = setup();
    const first = until(30);
    expect(
      await as("admin").setPlan({ userId: "ada", tier: "pro", endsAt: first, note: "press" }),
    ).toEqual({ plan: { tier: "pro", grantedUntil: first, ends: granted(first) } });
    expect(organizations.get("org-ada")?.grant).toEqual({
      tier: "pro",
      endsAt: new Date(first),
      grantedById: "admin",
      note: "press",
    });

    const second = until(60);
    expect(await as("admin").setPlan({ userId: "ada", tier: "max", endsAt: second })).toEqual({
      plan: { tier: "max", grantedUntil: second, ends: granted(second) },
    });
    expect(organizations.get("org-ada")?.grant).toMatchObject({
      tier: "max",
      endsAt: new Date(second),
      note: null,
    });

    expect(await as("admin").setPlan({ userId: "ada", tier: null })).toEqual({
      plan: { tier: "standard", grantedUntil: null, ends: null },
    });
    expect(organizations.get("org-ada")?.grant).toBeNull();
    // Nobody else's organization was touched.
    expect(organizations.get("org-admin")?.grant).toBeNull();

    // Tenant-visible: the admin only as an opaque id, never their email, nor the note.
    expect(JSON.stringify(audit.events)).not.toMatch(/press|owner@example/i);
    expect(audit.events).toEqual([
      {
        action: "plan.granted",
        actor: { type: "system", label: "Operator" },
        organizationId: "org-ada",
        target: { type: "user", id: "ada" },
        metadata: { adminId: "admin", tier: "pro", endsAt: first },
      },
      {
        action: "plan.granted",
        actor: { type: "system", label: "Operator" },
        organizationId: "org-ada",
        target: { type: "user", id: "ada" },
        metadata: { adminId: "admin", tier: "max", endsAt: second },
      },
      {
        action: "plan.grant_ended",
        actor: { type: "system", label: "Operator" },
        organizationId: "org-ada",
        target: { type: "user", id: "ada" },
        metadata: { adminId: "admin", tier: null, endsAt: null },
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
      plan: { tier: "max", grantedUntil: endsAt, ends: null },
    });
    expect(row.billing).toEqual({ status: "active", byokTier: "max" });
  });

  it("answers, and writes no audit record, for an end of a grant that was not there", async () => {
    const { as, planChanged } = setup();
    expect(await as("admin").setPlan({ userId: "ada", tier: null })).toEqual({
      plan: { tier: "standard", grantedUntil: null, ends: null },
    });
    expect(audit.events).toEqual([]);
    expect(planChanged).not.toHaveBeenCalled();
  });

  it("queues the mail before the end in the transaction that changes the plan", async () => {
    const { as, planChanged, prisma } = setup();
    await as("admin").setPlan({ userId: "ada", tier: "pro", endsAt: until(30) });
    await as("admin").setPlan({ userId: "ada", tier: null });
    expect(planChanged.mock.calls.map(([tx, organizationId]) => [tx, organizationId])).toEqual([
      [prisma, "org-ada"],
      [prisma, "org-ada"],
    ]);
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
    const at = new Date("2026-03-03T00:00:00Z");
    sessions().push({ id: "s-eve", userId: "eve", createdAt: at, updatedAt: at, userAgent: null });
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

describe("what keeps a plan and when it ends", () => {
  const plan = async (as: ReturnType<typeof setup>["as"]) =>
    (await as("admin").users({ query: "ada" })).users[0]?.plan;
  const fixture = (organizations: ReturnType<typeof setup>["organizations"]) => {
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    return row;
  };

  it("is the subscription's period: renewing, or ending when it is cancelled", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    const end = inDays(12);
    row.billing = { status: "active", byokTier: "pro", currentPeriodEndsAt: end };
    expect((await plan(as))?.ends).toEqual({
      source: "subscription",
      at: end.toISOString(),
      renews: true,
    });
    row.billing.cancelAtPeriodEnd = true;
    expect((await plan(as))?.ends).toMatchObject({ source: "subscription", renews: false });
  });

  it("is the trial's end while it is a trial, else its period's", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    const trial = inDays(3);
    const period = inDays(30);
    row.billing = {
      status: "trialing",
      byokTier: "max",
      trialEndsAt: trial,
      currentPeriodEndsAt: period,
    };
    expect((await plan(as))?.ends).toEqual({
      source: "trial",
      at: trial.toISOString(),
      renews: true,
    });
    row.billing.trialEndsAt = null;
    expect((await plan(as))?.ends).toMatchObject({ source: "trial", at: period.toISOString() });
  });

  it("names the plan that follows a grant above the subscription", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    const end = inDays(40);
    row.billing = { status: "active", byokTier: "pro", currentPeriodEndsAt: inDays(5) };
    row.grant = { tier: "max", endsAt: end, grantedById: "admin", note: null };
    expect((await plan(as))?.ends).toEqual({
      ...granted(end),
      fallsTo: { from: "Premium Plus", to: "Premium" },
    });
    // A subscription with no date left leaves an equal grant's end.
    row.billing = { status: "active", byokTier: "max" };
    expect((await plan(as))?.ends).toEqual(granted(end));
  });

  // Each as the member's own billing status tells it (statusPlanEnd): the admin sees the same end.
  it("is the later grant when a cancelled subscription of the same plan ends first", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    const end = inDays(40);
    row.billing = {
      status: "active",
      byokTier: "pro",
      currentPeriodEndsAt: inDays(20),
      cancelAtPeriodEnd: true,
    };
    row.grant = { tier: "pro", endsAt: end, grantedById: "admin", note: null };
    expect((await plan(as))?.ends).toEqual(granted(end));
  });

  it("is a subscription on credits' period, though it raises no plan", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    const end = inDays(10);
    row.billing = { status: "active", byokTier: null, currentPeriodEndsAt: end };
    expect(await plan(as)).toEqual({
      tier: "standard",
      grantedUntil: null,
      ends: { source: "subscription", at: end.toISOString(), renews: true },
    });
  });

  it("says a trial cancelled before it ends does not renew", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    row.billing = {
      status: "trialing",
      byokTier: "pro",
      trialEndsAt: inDays(4),
      cancelAtPeriodEnd: true,
    };
    expect((await plan(as))?.ends).toMatchObject({ source: "trial", renews: false });
  });

  it("is a running free period on Free with nothing else ending", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    const end = inDays(3);
    row.freeUntil = end;
    expect((await plan(as))?.ends).toEqual({
      source: "freeMonth",
      at: end.toISOString(),
      renews: false,
    });
    row.freeUntil = inDays(-1);
    expect((await plan(as))?.ends).toBeNull();
    // Paying, the free period is not what keeps the plan.
    row.freeUntil = inDays(9);
    row.billing = { status: "active", byokTier: "pro" };
    expect((await plan(as))?.ends).toBeNull();
  });
});

describe("sorting and filtering the list", () => {
  const ids = async (as: ReturnType<typeof setup>["as"], input: object) =>
    (await as("admin").users(input)).users.map((row) => row.id);

  it("sorts newest first by default, oldest first, or by email", async () => {
    const { as } = setup();
    expect(await ids(as, {})).toEqual(["bob", "ada", "squatter", "admin"]);
    expect(await ids(as, { sort: "oldest" })).toEqual(["admin", "squatter", "ada", "bob"]);
    expect(await ids(as, { sort: "email" })).toEqual(["admin", "ada", "bob", "squatter"]);
  });

  it("filters by status, and counts what matches beside the total", async () => {
    const { as, users } = setup();
    (users.find((row) => row.id === "bob") as User).deactivatedAt = new Date();
    const suspended = await as("admin").users({ status: "suspended" });
    expect(suspended.users.map((row) => row.id)).toEqual(["bob"]);
    expect(suspended).toMatchObject({ total: 4, matching: 1 });
    expect(await ids(as, { status: "active" })).toEqual(["ada", "squatter", "admin"]);
    expect((await as("admin").users({ query: "example" })).matching).toBe(4);
  });

  it("filters by the plan in force, by the same rule as the list", async () => {
    const { as, organizations } = setup();
    const ada = organizations.get("org-ada");
    const admin = organizations.get("org-admin");
    const squatter = organizations.get("org-squatter");
    if (!ada || !admin || !squatter) throw new Error("fixture");
    ada.billing = { status: "active", byokTier: "pro" };
    admin.grant = { tier: "max", endsAt: inDays(3), grantedById: "admin", note: null };
    // A lapsed subscription and an ended grant are Free.
    squatter.billing = { status: "canceled", byokTier: "max" };
    squatter.grant = { tier: "max", endsAt: inDays(-1), grantedById: "admin", note: null };
    expect(await ids(as, { plan: "pro" })).toEqual(["ada"]);
    expect(await ids(as, { plan: "max" })).toEqual(["admin"]);
    expect(await ids(as, { plan: "standard" })).toEqual(["bob", "squatter"]);
    const result = await as("admin").users({ plan: "max", query: "ada" });
    expect(result).toMatchObject({ users: [], matching: 0, total: 4 });
  });

  it("counts an account that owns several organizations at its highest plan", async () => {
    const { as, organizations, memberships } = setup();
    // Bob, who owned none, now owns a paying organization; Ada owns one too, beside her own.
    for (const userId of ["bob", "ada"])
      memberships.push({ userId, organizationId: "org-paid", role: "owner" });
    // Owning is what counts: a member of a paying organization is not on its plan.
    memberships.push({ userId: "squatter", organizationId: "org-paid", role: "member" });
    organizations.set("org-paid", { billing: { status: "active", byokTier: "max" }, grant: null });
    expect(await ids(as, { plan: "max" })).toEqual(["bob", "ada"]);
    expect(await ids(as, { plan: "standard" })).toEqual(["squatter", "admin"]);
  });

  it("filters in the list's own query, and counts only when something narrows it", async () => {
    const { as, prisma } = setup();
    await as("admin").users({});
    // The total alone: unfiltered, everything matches.
    expect(prisma.user.count).toHaveBeenCalledTimes(1);
    expect((await as("admin").users({})).matching).toBe(4);
    prisma.user.count.mockClear();
    prisma.member.findMany.mockClear();
    prisma.organization.findMany.mockClear();
    await as("admin").users({ plan: "standard" });
    expect(prisma.user.count).toHaveBeenCalledTimes(2);
    // The plans of the page's accounts, nothing more: no organization is read to filter.
    expect(prisma.member.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.organization.findMany).toHaveBeenCalledTimes(1);
    // The account filter keeps its own conditions beside the plan's.
    const [query] = prisma.user.findMany.mock.lastCall ?? [];
    const { where } = query as { where: Record<string, unknown> };
    expect(where).toMatchObject({ NOT: { email: { endsWith: expect.any(String) } } });
    expect(where.AND).toHaveLength(1);
  });

  it("filters only on the statuses that give a plan", () => {
    for (const status of [
      "trialing",
      "active",
      "past_due",
      "canceled",
      "incomplete",
      "incomplete_expired",
      "unpaid",
      "paused",
    ])
      expect(LIVE_BILLING_STATUSES.includes(status)).toBe(hasBillingAccess(status));
  });

  it("finds each account's own organization as the one-account lookup does", async () => {
    const { prisma, memberships } = setup();
    memberships.push({ userId: "bob", organizationId: "org-later", role: "member" });
    memberships.push({ userId: "ada", organizationId: "org-later", role: "admin,owner" });
    const ids = ["admin", "squatter", "ada", "bob"];
    const batch = await ownedOrganizations(prisma as never, ids);
    for (const userId of ids)
      expect(batch.get(userId)).toBe(
        await ownedOrganizationId(prisma as never, userId).catch((error) => {
          if (error instanceof IsolationError) return undefined;
          throw error;
        }),
      );
  });

  it("reads a page in the same number of queries whatever its size", async () => {
    const queries = async (count: number) => {
      const many = Array.from({ length: count }, (_, index) =>
        user(`u${index}`, `u${index}@example.test`, index + 10),
      );
      const { as, prisma } = setup([people[0] as User, ...many]);
      await as("admin").users({});
      return Object.values(prisma)
        .flatMap((model) =>
          typeof model === "function"
            ? [model]
            : Object.values(model as Record<string, ReturnType<typeof vi.fn>>),
        )
        .reduce((total, fn) => total + fn.mock.calls.length, 0);
    };
    const few = await queries(4);
    expect(await queries(DOZO_ADMIN_USERS_PAGE)).toBe(few);
    expect(await queries(DOZO_ADMIN_USERS_PAGE + 20)).toBe(few);
  });
});

describe("one account in full", () => {
  it("shows who it is, its plan and dates, where it works and its latest sign-ins", async () => {
    const { as, organizations, settings } = setup();
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    const period = inDays(20);
    row.billing = { status: "active", byokTier: "pro", currentPeriodEndsAt: period };
    row.freeUntil = inDays(-2);
    settings.modelCreditsEnabled = true;
    const account = await as("admin").user({ userId: "ada" });
    expect(account).toEqual({
      id: "ada",
      email: "ada@example.test",
      name: "ada",
      emailVerified: true,
      createdAt: "2026-01-03T00:00:00.000Z",
      suspended: false,
      banned: false,
      admin: false,
      plan: {
        tier: "pro",
        grantedUntil: null,
        ends: { source: "subscription", at: period.toISOString(), renews: true },
      },
      billing: {
        status: "active",
        trialEndsAt: null,
        currentPeriodEndsAt: period.toISOString(),
        cancelAtPeriodEnd: false,
      },
      // An ended free period is not shown.
      freeUntil: null,
      storage: { usedBytes: 3 * 1024 * 1024, limitBytes: 2 * 1024 * 1024 * 1024 },
      spaces: [
        { id: "space-ada", name: "Home", owned: true },
        { id: "space-admin", name: "Team", owned: false },
      ],
      bots: [
        { id: "bot-1", name: "Scout" },
        { id: "bot-2", name: "Quill" },
      ],
      computers: [
        {
          id: "pc-ada",
          running: true,
          ownMachine: false,
          runningSince: "2026-03-01T00:00:00.000Z",
          bots: ["Scout", "Quill"],
        },
        {
          id: "pc-own",
          running: true,
          ownMachine: true,
          runningSince: "2026-03-03T00:00:00.000Z",
          bots: ["Local"],
        },
        {
          id: "pc-off",
          running: false,
          ownMachine: false,
          runningSince: "2026-03-04T00:00:00.000Z",
          bots: ["Asleep"],
        },
      ],
      sessions: [
        {
          id: "s-3",
          createdAt: "2026-02-03T00:00:00.000Z",
          lastUsedAt: "2026-03-05T00:00:00.000Z",
          userAgent: null,
        },
        {
          id: "s-2",
          createdAt: "2026-02-02T00:00:00.000Z",
          lastUsedAt: "2026-03-02T00:00:00.000Z",
          userAgent: "Phone",
        },
      ],
    });
  });

  it("says an admin is one, a banned address is banned, and an account without an organization is on Free", async () => {
    const { as, users } = setup();
    expect(await as("admin").user({ userId: "admin" })).toMatchObject({ admin: true });
    await as("admin").ban({ value: "bob@example.test" });
    (users.find((row) => row.id === "bob") as User).emailVerified = false;
    expect(await as("admin").user({ userId: "bob" })).toMatchObject({
      admin: false,
      banned: true,
      suspended: false,
      emailVerified: false,
      plan: { tier: "standard", grantedUntil: null, ends: null },
      billing: null,
      freeUntil: null,
      storage: null,
      spaces: [],
      sessions: [],
    });
  });

  it("shows a trial with no period yet, and a computer that has not run", async () => {
    const { as, organizations, computers } = setup();
    const row = organizations.get("org-ada");
    const computer = computers.find((candidate) => candidate.id === "pc-off");
    if (!row || !computer) throw new Error("fixture");
    const trial = inDays(7);
    row.billing = { status: "trialing", byokTier: "max", trialEndsAt: trial };
    (computer as { runningSince: Date | null }).runningSince = null;
    const account = await as("admin").user({ userId: "ada" });
    expect(account.billing).toEqual({
      status: "trialing",
      trialEndsAt: trial.toISOString(),
      currentPeriodEndsAt: null,
      cancelAtPeriodEnd: false,
    });
    expect(account.computers.find((candidate) => candidate.id === "pc-off")).toMatchObject({
      running: false,
      runningSince: null,
    });
    // Billing off: files have no limit to show.
    expect(account.storage).toBeNull();
  });

  it("answers not found for an unknown account and an internal chat-app row", async () => {
    const { as } = setup();
    for (const userId of ["nobody", "chat"])
      await expect(as("admin").user({ userId })).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });
});

describe("renaming an account", () => {
  it("changes its name only, in the account's audit log", async () => {
    const { as, users } = setup();
    expect(await as("admin").rename({ userId: "ada", name: "  Ada L.  " })).toEqual({
      name: "Ada L.",
    });
    expect(users.find((row) => row.id === "ada")).toMatchObject({
      name: "Ada L.",
      email: "ada@example.test",
    });
    // Tenant-visible: the admin as an opaque id, and neither name.
    expect(audit.events).toEqual([
      {
        action: "user.renamed",
        actor: { type: "system", label: "Operator" },
        userId: "ada",
        target: { type: "user", id: "ada" },
        metadata: { adminId: "admin" },
      },
    ]);
  });

  it("refuses an empty name, an unknown account and a chat-app row", async () => {
    const { as, prisma } = setup();
    await expect(as("admin").rename({ userId: "ada", name: "   " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    for (const userId of ["nobody", "chat"])
      await expect(as("admin").rename({ userId, name: "X" })).rejects.toMatchObject({
        kind: "NOT_FOUND",
      });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(audit.events).toEqual([]);
  });
});

describe("signing an account out everywhere", () => {
  it("ends every way in it has, keeps it active, and records it", async () => {
    const { as, prisma, sessions, users, removePush, devices, disconnect } = setup();
    expect(await as("admin").endSessions({ userId: "ada" })).toEqual({ ok: true });
    expect(sessions().map((row) => row.userId)).toEqual(["admin"]);
    expect(devices[0]?.revokedAt).toBeInstanceOf(Date);
    expect(disconnect).toHaveBeenCalledWith("device-ada", "session-ended");
    expect(removePush).toHaveBeenCalledWith("ada");
    expect(prisma.callPushDevice.deleteMany).toHaveBeenCalledWith({ where: { userId: "ada" } });
    expect(prisma.messagingLinkCode.deleteMany).toHaveBeenCalledWith({ where: { userId: "ada" } });
    // Links to its bots' screens stop working.
    expect(prisma.bot.updateMany).toHaveBeenCalledWith({
      where: { userId: "ada" },
      data: { screenGeneration: { increment: 1 } },
    });
    // It can sign in again.
    expect(users.find((row) => row.id === "ada")?.deactivatedAt).toBeNull();
    expect(recordSecurityEvent).toHaveBeenCalledWith({
      type: "auth.session.revoked",
      userId: "ada",
      metadata: { by: "operator", admin: "admin", complete: true },
    });
  });

  it("tries every step when one fails, records it, then reports the failure", async () => {
    const { as, prisma, removePush, disconnect } = setup();
    prisma.session.deleteMany.mockRejectedValueOnce(new Error("database down"));
    await expect(as("admin").endSessions({ userId: "ada" })).rejects.toThrow(
      "Could not end every sign-in of the account",
    );
    expect(disconnect).toHaveBeenCalled();
    expect(removePush).toHaveBeenCalledWith("ada");
    expect(prisma.bot.updateMany).toHaveBeenCalled();
    expect(recordSecurityEvent).toHaveBeenCalledWith({
      type: "auth.session.revoked",
      userId: "ada",
      metadata: { by: "operator", admin: "admin", complete: false },
    });
  });

  it("lets an admin sign out of their own sessions, never another admin's", async () => {
    const { as, users, sessions } = setup();
    (users.find((row) => row.id === "squatter") as User).emailVerified = true;
    await expect(as("admin").endSessions({ userId: "squatter" })).rejects.toMatchObject({
      kind: "BAD_REQUEST",
    });
    expect(await as("admin").endSessions({ userId: "admin" })).toEqual({ ok: true });
    expect(sessions().some((row) => row.userId === "admin")).toBe(false);
  });

  it("answers not found for an unknown account, and is refused without the wiring", async () => {
    const { as, prisma } = setup();
    await expect(as("admin").endSessions({ userId: "chat" })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    await expect(
      setup(undefined, false).as("admin").endSessions({ userId: "ada" }),
    ).rejects.toThrow();
    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
  });
});
