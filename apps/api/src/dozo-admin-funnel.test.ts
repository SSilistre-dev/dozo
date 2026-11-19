import { createRouterClient } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunnelInput } from "./dozo-admin-funnel.js";
import { dozoAdminFunnelRoutes, funnelOf } from "./dozo-admin-funnel.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const now = new Date("2026-11-19T12:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const hour = 60 * 60 * 1000;
const at = (offset: number) => new Date(now.getTime() + offset);

function input(more: Partial<FunnelInput> = {}): FunnelInput {
  return {
    members: [],
    reached: {
      modelConnected: new Map(),
      firstBot: new Map(),
      firstMessage: new Map(),
      paid: new Map(),
    },
    granted: new Set(),
    ...more,
  };
}

describe("the funnel's arithmetic", () => {
  it("counts a step only for members who reached every step before it", () => {
    const signed = at(-5 * day);
    const funnel = funnelOf(
      input({
        members: ["a", "b", "c", "d"].map((id) => ({ id, createdAt: signed })),
        reached: {
          modelConnected: new Map([
            ["a", at(-5 * day + hour)],
            ["b", at(-5 * day + 3 * hour)],
            ["c", at(-5 * day + 2 * hour)],
          ]),
          // d made a bot without a model of its own: not counted past sign-up.
          firstBot: new Map([
            ["a", at(-4 * day)],
            ["b", at(-4 * day)],
            ["d", at(-4 * day)],
          ]),
          firstMessage: new Map([["a", at(-3 * day)]]),
          paid: new Map(),
        },
      }),
      30,
    );
    expect(funnel.steps.map((row) => [row.step, row.members, row.rate])).toEqual([
      ["signedUp", 4, null],
      ["modelConnected", 3, 75],
      ["firstBot", 2, 67],
      ["firstMessage", 1, 50],
      ["paid", 0, 0],
    ]);
    expect(funnel.days).toBe(30);
  });

  it("measures each step from the one before, as a median, and an earlier step as no time", () => {
    const signed = at(-10 * day);
    const funnel = funnelOf(
      input({
        members: ["a", "b", "c"].map((id) => ({ id, createdAt: signed })),
        reached: {
          modelConnected: new Map([
            ["a", new Date(signed.getTime() + hour)],
            ["b", new Date(signed.getTime() + 2 * hour)],
            ["c", new Date(signed.getTime() + 6 * hour)],
          ]),
          // b's bot came before its model: zero, not negative.
          firstBot: new Map([
            ["a", new Date(signed.getTime() + 2 * hour)],
            ["b", new Date(signed.getTime() + hour)],
          ]),
          firstMessage: new Map(),
          paid: new Map(),
        },
      }),
      30,
    );
    const seconds = funnel.steps.map((row) => row.medianSeconds);
    expect(seconds).toEqual([null, 2 * 3600, 1800, null, null]);
  });

  it("has no rate after an empty step, and nothing at all without sign-ups", () => {
    expect(funnelOf(input(), 7).steps.map((row) => [row.members, row.rate])).toEqual([
      [0, null],
      [0, null],
      [0, null],
      [0, null],
      [0, null],
    ]);
  });

  it("never counts a granted plan as paid, and shows it on its own", () => {
    const signed = at(-day);
    const reached = {
      modelConnected: new Map([
        ["paying", signed],
        ["given", signed],
        ["both", signed],
      ]),
      firstBot: new Map([
        ["paying", signed],
        ["given", signed],
        ["both", signed],
      ]),
      firstMessage: new Map([
        ["paying", signed],
        ["given", signed],
        ["both", signed],
      ]),
      paid: new Map([
        ["paying", signed],
        ["both", signed],
      ]),
    };
    const funnel = funnelOf(
      input({
        members: ["paying", "given", "both"].map((id) => ({ id, createdAt: signed })),
        reached,
        // "outside" signed up before the period.
        granted: new Set(["given", "both", "outside"]),
      }),
      90,
    );
    expect(funnel.steps.at(-1)).toMatchObject({ step: "paid", members: 2 });
    expect(funnel.granted).toBe(1);
  });
});

type Row = { id: string; email: string; createdAt: Date };

/** A database that answers the funnel's reads from fixed rows, applying their filters. */
function database() {
  const users: Row[] = [
    { id: "admin", email: "owner@example.test", createdAt: at(-400 * day) },
    // Signed up 30 days ago to the millisecond: inside the 30-day period.
    { id: "edge", email: "edge@example.test", createdAt: at(-30 * day) },
    // A millisecond earlier: outside it.
    { id: "early", email: "early@example.test", createdAt: at(-30 * day - 1) },
    { id: "ada", email: "ada@example.test", createdAt: at(-3 * day) },
    // Suspended: still counted.
    { id: "sus", email: "sus@example.test", createdAt: at(-2 * day) },
    { id: "gift", email: "gift@example.test", createdAt: at(-2 * day) },
    // A chat-app contact is not a member.
    { id: "contact", email: "x@messaging.invalid", createdAt: at(-day) },
  ];
  const ever = (ids: string[]) =>
    ids.flatMap((id) => [{ userId: id, _min: { createdAt: at(-day) } }]);
  const inIds = (where: { userId?: { in: string[] }; authorUserId?: { in: string[] } }) =>
    (where.userId ?? where.authorUserId)!.in;
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const user = users.find((row) => row.id === where.id);
        return user ? { ...user, emailVerified: true } : null;
      }),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { createdAt: { gte: Date }; NOT: { email: { endsWith: string } } };
        }) =>
          users
            .filter(
              (row) =>
                row.createdAt >= where.createdAt.gte &&
                !row.email.endsWith(where.NOT.email.endsWith),
            )
            .map(({ id, createdAt }) => ({ id, createdAt })),
      ),
    },
    userModelCredential: {
      groupBy: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        // "gone" is a deleted account whose rows a test leaves behind; never asked for.
        ever(["edge", "early", "ada", "sus", "gift", "gone"]).filter((row) =>
          inIds(where).includes(row.userId),
        ),
      ),
    },
    bot: {
      groupBy: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        ever(["ada", "sus", "gift", "gone"]).filter((row) => inIds(where).includes(row.userId)),
      ),
    },
    message: {
      groupBy: vi.fn(async ({ where }: { where: { authorUserId: { in: string[] } } }) =>
        ["ada", "sus", "gift", "gone"]
          .filter((id) => inIds(where).includes(id))
          .map((id) => ({
            authorUserId: id,
            _min: { createdAt: at(-day + hour) } as { createdAt: Date | null },
          }))
          // A group without a time is no first message.
          .concat([{ authorUserId: "edge", _min: { createdAt: null } }]),
      ),
    },
    member: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        [
          { userId: "ada", organizationId: "org-ada", role: "owner" },
          // Ada also owns an organization that paid later: the first payment counts.
          { userId: "ada", organizationId: "org-ada-2", role: "owner" },
          { userId: "gift", organizationId: "org-gift", role: "owner" },
          // A member of a paying team who does not own it has not paid.
          { userId: "sus", organizationId: "org-ada", role: "member" },
        ].filter((row) => where.userId.in.includes(row.userId)),
      ),
    },
    billingAccount: {
      findMany: vi.fn(async ({ where }: { where: { organizationId: { in: string[] } } }) =>
        [
          { organizationId: "org-ada-2", paidAt: at(-hour / 2) },
          { organizationId: "org-ada", paidAt: at(-hour) },
          { organizationId: "org-ada-2", paidAt: at(-hour / 4) },
        ].filter((row) => where.organizationId.in.includes(row.organizationId)),
      ),
    },
    dozoPlanGrant: {
      findMany: vi.fn(async ({ where }: { where: { organizationId: { in: string[] } } }) =>
        [{ organizationId: "org-gift" }].filter((row) =>
          where.organizationId.in.includes(row.organizationId),
        ),
      ),
    },
  };
  const deps = { prisma, env: { adminEmails: ["owner@example.test"] } } as unknown as RouterDeps;
  const routes = { dozoAdmin: { funnel: dozoAdminFunnelRoutes(createRouterContext(deps)) } };
  const as = (userId: string) =>
    createRouterClient(routes, {
      context: {
        actor: { userId, spaceId: `space-${userId}`, email: "", isDeploymentOwner: false },
      },
    }).dozoAdmin.funnel;
  return { prisma, as };
}

describe("the funnel procedure", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("refuses anyone who is not an admin, before anything is read", async () => {
    const { as, prisma } = database();
    await expect(as("ada").read({ days: 30 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("refuses a period it does not offer", async () => {
    const { as } = database();
    await expect(as("admin").read({ days: 14 as 7 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("counts the period's members step by step, from grouped reads", async () => {
    const { as, prisma } = database();
    const funnel = await as("admin").read({ days: 30 });
    // edge, ada, sus and gift; not early, the admin, the contact or the deleted account.
    expect(funnel.steps.map((row) => [row.step, row.members, row.rate])).toEqual([
      ["signedUp", 4, null],
      ["modelConnected", 4, 100],
      ["firstBot", 3, 75],
      ["firstMessage", 3, 100],
      ["paid", 1, 33],
    ]);
    expect(funnel.granted).toBe(1);
    // Ada's first payment, an hour ago, after her first message a day ago less an hour.
    expect(funnel.steps[4]!.medianSeconds).toBe(day / 1000 - 2 * 3600);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { gte: at(-30 * day) } }),
      }),
    );
    for (const read of [prisma.userModelCredential, prisma.bot, prisma.message])
      expect(read.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.message.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ role: "user" }) }),
    );
    expect(prisma.billingAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: { in: ["org-ada", "org-ada-2", "org-gift"] },
          paidAt: { not: null },
        },
      }),
    );
  });

  it("reads a shorter period from its own boundary", async () => {
    const { as } = database();
    const funnel = await as("admin").read({ days: 7 });
    expect(funnel.steps[0]).toMatchObject({ members: 3 });
  });
});
