import { createRouterClient } from "@orpc/server";
import {
  accountDeactivated,
  hasBillingAccess,
  IsolationError,
  ownedOrganizationId,
  recordSecurityEvent,
} from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DOZO_ADMIN_USERS_PAGE, dozoAdminRoutes, spendingLimitRoutes } from "./dozo-admin.js";
import type { User } from "./dozo-admin.test-support.js";
import { inDays, people, setup, user } from "./dozo-admin.test-support.js";
import { LIVE_BILLING_STATUSES, ownedOrganizations } from "./dozo-admin-members.js";
import { audit, host, stops } from "./dozo-admin-mocks.test-support.js";

vi.mock("./routes/computer.js", async () =>
  (await import("./dozo-admin-mocks.test-support.js")).computerRoutesMock(),
);
vi.mock("@rakazo/adapters", async (original) =>
  (await import("./dozo-admin-mocks.test-support.js")).adaptersMock(original),
);
vi.mock("@rakazo/db", async (original) =>
  (await import("./dozo-admin-mocks.test-support.js")).dbMock(original),
);

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

  it("suspends and marks every account a banned domain covers, subdomains included", async () => {
    const users = [
      ...people.map((row) => ({ ...row })),
      user("eve", "eve@corp.test", 6),
      user("mal", "Mal@Mail.Corp.TEST", 7),
      user("ann", "ann@notcorp.test", 8),
    ];
    const { as, sessions } = setup(users);
    const at = new Date("2026-03-03T00:00:00Z");
    sessions().push({ id: "s-eve", userId: "eve", createdAt: at, updatedAt: at, userAgent: null });
    await as("admin").ban({ value: "corp.test" });
    const listed = (await as("admin").users({})).users;
    expect(listed.filter((row) => row.banned).map((row) => row.id)).toEqual(["mal", "eve"]);
    expect(listed.filter((row) => row.suspended).map((row) => row.id)).toEqual(["mal", "eve"]);
    expect(sessions().some((row) => row.userId === "eve")).toBe(false);
  });

  it("suspends the account a banned address names, in any spelling", async () => {
    const users = [
      ...people.map((row) => ({ ...row })),
      user("eve", "E.ve+tag@GoogleMail.com", 6),
      user("steve", "steve@gmail.com", 7),
    ];
    const { as } = setup(users);
    await as("admin").ban({ value: "eve@gmail.com" });
    const listed = (await as("admin").users({})).users;
    expect(listed.filter((row) => row.suspended).map((row) => row.id)).toEqual(["eve"]);
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
      suspended: true,
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
