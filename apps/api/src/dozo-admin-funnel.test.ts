import { createRouterClient } from "@orpc/server";
import { Prisma } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunnelInput } from "./dozo-admin-funnel.js";
import { DOZO_FUNNEL_CACHE_MS, dozoAdminFunnelRoutes, funnelOf } from "./dozo-admin-funnel.js";
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

/** The text and values of a query, its fragments spelled out. */
function flatten(strings: readonly string[], values: unknown[]) {
  const sql = Prisma.sql(strings, ...values);
  return { text: sql.text, values: sql.values };
}

/**
 * A database that answers each of the funnel's reads with fixed rows, as they would come back for
 * the period asked. The SQL itself runs against Postgres in the branch's own check, not here.
 */
function database() {
  const rows = {
    members: [
      { id: "edge", createdAt: at(-30 * day) },
      { id: "ada", createdAt: at(-3 * day) },
      { id: "sus", createdAt: at(-2 * day) },
      { id: "gift", createdAt: at(-2 * day) },
    ],
    credentials: ["edge", "ada", "sus", "gift"].map((id) => ({ id, at: at(-day) })),
    bots: ["ada", "sus", "gift"].map((id) => ({ id, at: at(-day) })),
    messages: ["ada", "sus", "gift"].map((id) => ({ id, at: at(-day + hour) })),
    paid: [{ id: "ada", at: at(-hour) }],
    granted: [{ id: "gift" }],
  };
  const queries: { text: string; values: unknown[] }[] = [];
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "admin"
          ? { id: "admin", email: "owner@example.test", emailVerified: true }
          : null,
      ),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = flatten(strings, values);
      queries.push(query);
      const { text } = query;
      if (text.includes("user_model_credentials")) return rows.credentials;
      if (text.includes("FROM bots")) return rows.bots;
      if (text.includes("FROM messages")) return rows.messages;
      if (text.includes("billing_accounts")) return rows.paid;
      if (text.includes("dozo_plan_grants")) return rows.granted;
      return rows.members;
    }),
  };
  const deps = { prisma, env: { adminEmails: ["owner@example.test"] } } as unknown as RouterDeps;
  const routes = { dozoAdmin: { funnel: dozoAdminFunnelRoutes(createRouterContext(deps)) } };
  const as = (userId: string) =>
    createRouterClient(routes, {
      context: {
        actor: { userId, spaceId: `space-${userId}`, email: "", isDeploymentOwner: false },
      },
    }).dozoAdmin.funnel;
  return { prisma, as, queries, rows };
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
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("refuses a period it does not offer", async () => {
    const { as } = database();
    await expect(as("admin").read({ days: 14 as 7 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("counts the period's members step by step, every read joined to the period's members", async () => {
    const { as, queries } = database();
    const funnel = await as("admin").read({ days: 30 });
    expect(funnel.steps.map((row) => [row.step, row.members, row.rate])).toEqual([
      ["signedUp", 4, null],
      ["modelConnected", 4, 100],
      ["firstBot", 3, 75],
      ["firstMessage", 3, 100],
      ["paid", 1, 33],
    ]);
    expect(funnel.granted).toBe(1);
    // Ada's payment, an hour ago, after her first message a day ago less an hour.
    expect(funnel.steps[4]!.medianSeconds).toBe(day / 1000 - 2 * 3600);
    expect(queries).toHaveLength(6);
    for (const query of queries) {
      // From the period's start to the millisecond, people only, and no list of ids.
      expect(query.text).toContain('u."createdAt" >= $1 AND u.email NOT LIKE $2');
      expect(query.values).toEqual([at(-30 * day), "%@messaging.invalid"]);
    }
    const messages = queries.find((query) => query.text.includes("FROM messages"))!;
    expect(messages.text).toContain("CROSS JOIN LATERAL");
    expect(messages.text).toContain("m.role = 'user'");
  });

  it("reuses a period's count for a minute, and reads again after a failure", async () => {
    const { as, prisma } = database();
    await as("admin").read({ days: 30 });
    await as("admin").read({ days: 30 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(6);
    await as("admin").read({ days: 7 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(12);
    vi.setSystemTime(new Date(now.getTime() + DOZO_FUNNEL_CACHE_MS + 1));
    prisma.$queryRaw.mockRejectedValueOnce(new Error("down"));
    await expect(as("admin").read({ days: 30 })).rejects.toThrow();
    await as("admin").read({ days: 30 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(24);
  });
});
