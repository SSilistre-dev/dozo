import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { spendingLimitRoutes } from "./dozo-admin.js";
import { cacheSavings, dozoUsageRoutes, usagePeriodStart } from "./dozo-usage.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const NOW = new Date("2026-11-19T12:00:00Z");
const MONTH = new Date("2026-11-01T00:00:00Z");
const SINCE = new Date("2026-11-05T00:00:00Z");

describe("the cache share", () => {
  const none = { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null };

  it("is nothing without input", () => {
    expect(cacheSavings(none, SINCE)).toBeNull();
    expect(cacheSavings({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, SINCE)).toBe(
      null,
    );
  });

  it("is zero when the cache was only written", () => {
    expect(cacheSavings({ ...none, cacheWriteTokens: 4000 }, SINCE)).toEqual({
      since: SINCE.toISOString(),
      inputTokens: 4000,
      cacheReadTokens: 0,
      cacheReadPercent: 0,
    });
  });

  it("counts uncached input, reads and writes as the input, and rounds down", () => {
    expect(
      cacheSavings({ inputTokens: 1000, cacheReadTokens: 7200, cacheWriteTokens: 1800 }, SINCE),
    ).toEqual({
      since: SINCE.toISOString(),
      inputTokens: 10_000,
      cacheReadTokens: 7200,
      cacheReadPercent: 72,
    });
    expect(
      cacheSavings({ inputTokens: 1, cacheReadTokens: 999, cacheWriteTokens: null }, SINCE)
        ?.cacheReadPercent,
    ).toBe(99);
    expect(
      cacheSavings({ inputTokens: null, cacheReadTokens: 50, cacheWriteTokens: null }, SINCE)
        ?.cacheReadPercent,
    ).toBe(100);
  });
});

type Billing = {
  status: string | null;
  currentPeriodStartsAt: Date | null;
  byokInterval?: string | null;
} | null;

function periodPrisma(organization: string | null, billing: Billing) {
  return {
    space: {
      findUnique: async () => (organization ? { organizationId: organization } : null),
    },
    member: { findUnique: async () => ({ role: "owner" }) },
    billingAccount: {
      findUnique: async () => (billing ? { byokInterval: "month", ...billing } : null),
    },
  } as unknown as RouterDeps["prisma"];
}

describe("the period", () => {
  const member = { spaceId: "space-ada", userId: "ada" };
  const start = (organization: string | null, billing: Billing) =>
    usagePeriodStart(periodPrisma(organization, billing), member, NOW);

  it("is the live subscription's billing period", async () => {
    expect(await start("org", { status: "active", currentPeriodStartsAt: SINCE })).toEqual(SINCE);
    expect(await start("org", { status: "trialing", currentPeriodStartsAt: SINCE })).toEqual(SINCE);
  });

  it("is the current month of a yearly plan, on the day its period began", async () => {
    // A yearly plan that began on 5 March renews monthly: on 19 November its month began on 5 November.
    const yearly = { status: "active", byokInterval: "year" };
    const march = new Date("2026-03-05T00:00:00Z");
    expect(await start("org", { ...yearly, currentPeriodStartsAt: march })).toEqual(SINCE);
    // Before this month's anniversary, the month began on last month's.
    const late = new Date("2026-02-25T00:00:00Z");
    expect(await start("org", { ...yearly, currentPeriodStartsAt: late })).toEqual(
      new Date("2026-10-25T00:00:00Z"),
    );
  });

  it("is the calendar month in UTC otherwise", async () => {
    expect(await start(null, null)).toEqual(MONTH);
    expect(await start("org", null)).toEqual(MONTH);
    expect(await start("org", { status: "canceled", currentPeriodStartsAt: SINCE })).toEqual(MONTH);
    expect(await start("org", { status: "active", currentPeriodStartsAt: null })).toEqual(MONTH);
    const later = new Date("2026-12-01T00:00:00Z");
    expect(await start("org", { status: "active", currentPeriodStartsAt: later })).toEqual(MONTH);
  });

  it("reads the clock when not given one", async () => {
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    expect(await usagePeriodStart(periodPrisma(null, null), member)).toEqual(month);
  });
});

type Row = {
  spaceId: string;
  userId: string;
  createdAt: Date;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

function setup(rows: Row[]) {
  type Where = {
    spaceId: string;
    userId: string;
    createdAt: { gte: Date };
    inputTokens?: { not: null };
    cacheReadTokens?: { not: null };
  };
  const prisma = {
    space: { findUnique: async () => null },
    usageRecord: {
      aggregate: async ({ where }: { where: Where }) => {
        const matched = rows.filter(
          (row) =>
            row.spaceId === where.spaceId &&
            row.userId === where.userId &&
            row.createdAt >= where.createdAt.gte &&
            (!where.inputTokens || row.inputTokens !== null) &&
            (!where.cacheReadTokens || row.cacheReadTokens !== null),
        );
        const sum = (field: "inputTokens" | "cacheReadTokens" | "cacheWriteTokens") => {
          const known = matched.map((row) => row[field]).filter((value) => value !== null);
          return known.length ? known.reduce((a, b) => a + b, 0) : null;
        };
        return {
          _sum: {
            inputTokens: sum("inputTokens"),
            cacheReadTokens: sum("cacheReadTokens"),
            cacheWriteTokens: sum("cacheWriteTokens"),
          },
        };
      },
    },
  };
  const ctx = createRouterContext({
    prisma,
    events: { notify: () => undefined, publishSpaceChange: () => undefined },
    env: {},
  } as unknown as RouterDeps);
  const as = (userId: string, spaceId = `space-${userId}`) =>
    createRouterClient(dozoUsageRoutes(ctx), {
      context: {
        actor: { userId, spaceId, email: `${userId}@example.test`, isDeploymentOwner: false },
      },
    }).dozoUsage;
  return { ctx, as };
}

describe("who sees the cache share", () => {
  const thisMonth = new Date();
  const row = (spaceId: string, userId: string, read: number, more: Partial<Row> = {}): Row => ({
    spaceId,
    userId,
    createdAt: thisMonth,
    inputTokens: 100,
    cacheReadTokens: read,
    cacheWriteTokens: 0,
    ...more,
  });

  it("counts only the caller's own usage in the current Space and period", async () => {
    const { as } = setup([
      row("space-ada", "ada", 300),
      // Another person in the same Space, and the caller in another Space.
      row("space-ada", "bob", 900_000),
      row("space-other", "ada", 900_000),
      // Before the period.
      row("space-ada", "ada", 900_000, { createdAt: new Date("2020-01-01T00:00:00Z") }),
    ]);
    expect(await as("ada").cacheSavings()).toMatchObject({
      inputTokens: 400,
      cacheReadTokens: 300,
      cacheReadPercent: 75,
    });
  });

  it("leaves out records whose input or cache reads were not measured", async () => {
    const { as } = setup([
      row("space-ada", "ada", 300),
      // Reads not measured: counting its input with no reads would lower the share.
      row("space-ada", "ada", 0, { cacheReadTokens: null, inputTokens: 5000 }),
      // Input not measured.
      row("space-ada", "ada", 900, { inputTokens: null }),
      // Writes not measured count as none.
      row("space-ada", "ada", 100, { cacheWriteTokens: null }),
    ]);
    expect(await as("ada").cacheSavings()).toMatchObject({
      inputTokens: 600,
      cacheReadTokens: 400,
      cacheReadPercent: 66,
    });
  });

  it("is nothing when no record was measured", async () => {
    const { as } = setup([row("space-ada", "ada", 0, { cacheReadTokens: null })]);
    expect(await as("ada").cacheSavings()).toBeNull();
  });

  it("gives nothing to someone with no usage, however much others have", async () => {
    const { as } = setup([row("space-ada", "ada", 900_000)]);
    expect(await as("eve", "space-ada").cacheSavings()).toBeNull();
  });

  it("refuses a caller who is not signed in", async () => {
    const { ctx } = setup([row("space-ada", "ada", 300)]);
    const client = createRouterClient(dozoUsageRoutes(ctx), { context: { actor: null } });
    await expect(client.dozoUsage.cacheSavings()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("joins the routes the router imports", () => {
    expect(Object.keys(spendingLimitRoutes(setup([]).ctx))).toContain("dozoUsage");
  });
});
