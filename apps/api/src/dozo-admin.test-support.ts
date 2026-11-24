import { createRouterClient } from "@orpc/server";
import { vi } from "vitest";
import type { DozoAdminWiring } from "./dozo-admin.js";
import { dozoAdminRoutes, dozoAdminWiring } from "./dozo-admin.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

export type User = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  createdAt: Date;
  deactivatedAt: Date | null;
};

export function user(id: string, email: string, day: number, more: Partial<User> = {}): User {
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
  // Everyone owns an organization of their own, except Bob, who has none.
  const memberships = users
    .filter((row) => row.id !== "bob")
    .map((row) => ({ userId: row.id, organizationId: `org-${row.id}`, role: "owner" }));
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
  const matches = (row: User, where: Where = {}): boolean => {
    if (where.NOT && matches(row, where.NOT)) return false;
    if (where.AND && !where.AND.every((part: Where) => matches(row, part))) return false;
    if (typeof where.id === "string" && row.id !== where.id) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.OR && !where.OR.some((part: Where) => matches(row, part))) return false;
    if (
      where.email?.endsWith &&
      !(where.email.mode === "insensitive" ? row.email.toLowerCase() : row.email).endsWith(
        where.email.endsWith,
      )
    )
      return false;
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
    deploymentSettings: { findUnique: vi.fn(async () => settings) },
    spaceMember: {
      findMany: vi.fn(async ({ where }: Where) =>
        spaces.filter((row) => row.userId === where.userId).map(({ space }) => ({ space })),
      ),
    },
    $queryRaw: vi.fn(async (sql: TemplateStringsArray, keys: string[]) => {
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
    bans,
    site,
    memberships,
    settings,
    computers,
    devices,
  };
}

export const people = [
  user("admin", "Owner@Example.test", 1),
  user("squatter", "second@example.test", 2, { emailVerified: false }),
  user("ada", "ada@example.test", 3),
  user("bob", "bob@example.test", 4),
  user("chat", "tg-1@messaging.invalid", 5),
];

export function setup(
  users: User[] = people.map((row) => ({ ...row })),
  wiring = true,
  sandboxId?: string,
) {
  const { prisma, sessions, bans, site, memberships, settings, computers, devices } = world(users);
  const disconnect = vi.fn(async () => undefined);
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
    prisma,
    sessions,
    users,
    ctx,
    as,
    removePush,
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
