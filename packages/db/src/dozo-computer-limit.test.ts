import { PLAN_LIMIT_CODES } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { ComputerLimitError, ensureComputerRecord } from "./computers.js";
import {
  assertOwnComputerAllowed,
  computerLimitFor,
  computerLimitRefusal,
  SHARED_COMPUTER_LIMIT_CODE,
  SharedComputerLimitError,
} from "./dozo-computer-limit.js";

// Runs on the branded tree only: `ensureComputerRecord` throws the refusal once the rule is applied.

type Row = {
  id: string;
  spaceId: string;
  userId: string;
  scope: "team" | "dedicated";
  scopeKey: string;
  bots: { id: string; archivedAt: Date | null }[];
};
type Where = {
  id?: string;
  spaceId?: string;
  scope?: string | { not: string };
  userId?: string;
  bots?: { some: { archivedAt: null; id?: { not: string } } };
};

/** Evaluates the few computer filters the quota reads, over rows held in memory. */
function fakeDb(rows: Row[]) {
  const live = (row: Row, some: NonNullable<Where["bots"]>["some"]) =>
    row.bots.some((bot) => bot.archivedAt === null && bot.id !== some.id?.not);
  const matches = (where: Where) => (row: Row) =>
    (where.userId === undefined || row.userId === where.userId) &&
    (where.spaceId === undefined || row.spaceId === where.spaceId) &&
    (where.scope === undefined ||
      (typeof where.scope === "string"
        ? row.scope === where.scope
        : row.scope !== where.scope.not)) &&
    (where.bots === undefined || live(row, where.bots.some));
  return {
    $queryRaw: vi.fn(async () => [{ lock: "1" }]),
    computer: {
      findUnique: vi.fn(
        async ({ where }: { where: { scopeKey: string } }) =>
          rows.find((row) => row.scopeKey === where.scopeKey) ?? null,
      ),
      count: vi.fn(async ({ where }: { where: Where }) => rows.filter(matches(where)).length),
      upsert: vi.fn(async () => ({ id: "new" })),
    },
  } as unknown as PrismaClient;
}

const bot = (id: string, archived = false) => ({ id, archivedAt: archived ? new Date() : null });
/** The owner's account in the live report: one Team Computer shared by four live bots, two archived. */
const sharedTeam = (): Row[] => [
  {
    id: "team-1",
    spaceId: "space-1",
    userId: "user-1",
    scope: "team",
    scopeKey: "team:space-1:user-1",
    bots: [bot("b1"), bot("b2"), bot("b3"), bot("b4"), bot("b5", true), bot("b6", true)],
  },
];
const ownComputer = (): Row => ({
  id: "own-1",
  spaceId: "space-1",
  userId: "user-1",
  scope: "dedicated",
  scopeKey: "bot:b9",
  bots: [bot("b9")],
});
const asking = { spaceId: "space-1", userId: "user-1", kind: "docker" };

afterEach(() => {
  delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
});

describe("the computer limit with every bot on one shared Team Computer", () => {
  it("refuses a bot's own computer, saying the Team Computer is the way", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const error = await ensureComputerRecord(fakeDb(sharedTeam()), {
      ...asking,
      mode: "dedicated",
      botId: "b4",
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SharedComputerLimitError);
    expect((error as SharedComputerLimitError).code).toBe(PLAN_LIMIT_CODES.computerLimitShared);
    expect((error as SharedComputerLimitError).code).toBe(SHARED_COMPUTER_LIMIT_CODE);
  });

  it("lets the bots keep using the Team Computer at the limit", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    await expect(
      ensureComputerRecord(fakeDb(sharedTeam()), { ...asking, mode: "team", botId: "b4" }),
    ).resolves.toBeDefined();
  });

  it("does not count the archived bots: two archived bots hold no computer", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const archivedOnly: Row[] = [{ ...sharedTeam()[0]!, bots: [bot("b5", true), bot("b6", true)] }];
    await expect(
      ensureComputerRecord(fakeDb(archivedOnly), { ...asking, mode: "dedicated", botId: "b1" }),
    ).resolves.toBeDefined();
  });

  it("keeps the archive advice when a bot's own computer fills the limit", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const error = await ensureComputerRecord(fakeDb([ownComputer()]), {
      ...asking,
      mode: "dedicated",
      botId: "b4",
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ComputerLimitError);
    expect((error as ComputerLimitError).code).toBe(PLAN_LIMIT_CODES.computerLimit);
  });

  it("keeps the archive advice for a Team Computer in another Space", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const error = await ensureComputerRecord(fakeDb(sharedTeam()), {
      ...asking,
      spaceId: "space-2",
      mode: "team",
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ComputerLimitError);
  });
});

describe("a bot's own computer in a Space without a Team Computer", () => {
  it("keeps the archive advice: the person's Team Computer is in another Space", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const error = await ensureComputerRecord(fakeDb(sharedTeam()), {
      ...asking,
      spaceId: "space-2",
      mode: "dedicated",
      botId: "b4",
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ComputerLimitError);
    expect((error as ComputerLimitError).code).toBe(PLAN_LIMIT_CODES.computerLimit);
  });
});

describe("computerLimitRefusal", () => {
  const fallback = new ComputerLimitError(1);

  it("asks only about computers the bot's person still backs, other than the bot's own", async () => {
    const db = fakeDb([ownComputer()]);
    await computerLimitRefusal(db, { mode: "dedicated", spaceId: "space-1", userId: "user-1", botId: "b9" }, 1, fallback);
    expect(db.computer.count).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        scope: { not: "team" },
        bots: { some: { archivedAt: null, id: { not: "b9" } } },
      },
    });
  });

  it("is the fallback for a team request, without a query", async () => {
    const db = fakeDb([]);
    await expect(
      computerLimitRefusal(db, { mode: "team", spaceId: "space-1", userId: "user-1" }, 1, fallback),
    ).resolves.toBe(fallback);
    expect(db.computer.count).not.toHaveBeenCalled();
  });
});

/** A database that bills (or not), with one Space on a plan and an admin limit (or none). */
function planDb(options: { bills?: boolean; tier?: string | null; admin?: number | null }) {
  const { bills = true, tier = null, admin = null } = options;
  return {
    $queryRaw: vi.fn(async () => [{ maxComputersPerUser: admin }]),
    deploymentSettings: { findUnique: vi.fn(async () => ({ modelCreditsEnabled: bills })) },
    space: {
      findUnique: vi.fn(async () => ({
        organization: {
          billing: tier ? { status: "active", byokTier: tier } : null,
          dozoPlanGrant: null,
        },
      })),
    },
    computer: { findUnique: vi.fn(async () => ({ spaceId: "space-1" })) },
    dozoPlanQuota: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClient;
}

describe("computerLimitFor: the plan's count", () => {
  it("is one on Premium and three on Premium Plus, whatever the environment says", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "9";
    expect(await computerLimitFor(planDb({ tier: "pro" }), { spaceId: "space-1" })).toBe(1);
    expect(await computerLimitFor(planDb({ tier: "max" }), { spaceId: "space-1" })).toBe(3);
  });

  it("finds the Space of a computer, for a restore", async () => {
    const db = planDb({ tier: "max" });
    expect(await computerLimitFor(db, { computerId: "own-1" })).toBe(3);
    expect(db.computer.findUnique).toHaveBeenCalled();
  });

  it("keeps an admin's limit as an upper bound, never a raise", async () => {
    expect(await computerLimitFor(planDb({ tier: "max", admin: 2 }), { spaceId: "s" })).toBe(2);
    expect(await computerLimitFor(planDb({ tier: "pro", admin: 5 }), { spaceId: "s" })).toBe(1);
    expect(await computerLimitFor(planDb({ tier: "max", admin: 0 }), { spaceId: "s" })).toBe(3);
  });

  it("leaves Free to the site's limit: it has no hosted computer to count", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "4";
    expect(await computerLimitFor(planDb({ tier: null }), { spaceId: "s" })).toBe(4);
    expect(await computerLimitFor(planDb({ tier: null, admin: 2 }), { spaceId: "s" })).toBe(2);
  });

  it("uses the environment only where there is no plan: a server that does not bill", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "6";
    expect(await computerLimitFor(planDb({ bills: false, tier: "pro" }), { spaceId: "s" })).toBe(6);
    expect(await computerLimitFor(planDb({ bills: false, admin: 3 }), { spaceId: "s" })).toBe(3);
  });

  it("has no plan without a Space to read it from, and none from a bare test double", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "7";
    expect(await computerLimitFor(planDb({ tier: "pro" }), {})).toBe(7);
    const missing = planDb({ tier: "pro" });
    (missing.space.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    expect(await computerLimitFor(missing, { spaceId: "gone" })).toBe(7);
    expect(await computerLimitFor({ computer: {} }, { spaceId: "s" })).toBe(7);
    expect(await computerLimitFor({ $queryRaw: async () => [], computer: {} }, {})).toBe(7);
  });
});

/** The computer table of `fakeDb` on a database that bills, with the Space on a plan. */
function planned(tier: string | null, rows: Row[] = []) {
  const quota = fakeDb(rows);
  const plan = planDb({ tier });
  return { ...plan, computer: { ...plan.computer, ...quota.computer } } as unknown as PrismaClient;
}

describe("a plan with one computer is the Team Computer", () => {
  const own = { ...asking, mode: "dedicated" as const, botId: "b4" };

  it("refuses a bot's own computer on Premium with the Team Computer's way out", async () => {
    const error = await ensureComputerRecord(planned("pro"), own).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SharedComputerLimitError);
    expect((error as SharedComputerLimitError).code).toBe(PLAN_LIMIT_CODES.computerLimitShared);
  });

  it("still opens the Team Computer on Premium", async () => {
    await expect(
      ensureComputerRecord(planned("pro"), { ...asking, mode: "team" }),
    ).resolves.toBeDefined();
  });

  it("lets Premium Plus have its own, up to three", async () => {
    await expect(ensureComputerRecord(planned("max"), own)).resolves.toBeDefined();
    const two: Row[] = [
      { ...ownComputer(), id: "o1", scopeKey: "bot:o1", bots: [bot("o1")] },
      { ...ownComputer(), id: "o2", scopeKey: "bot:o2", bots: [bot("o2")] },
      { ...ownComputer(), id: "o3", scopeKey: "bot:o3", bots: [bot("o3")] },
    ];
    const error = await ensureComputerRecord(planned("max", two), own).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComputerLimitError);
  });

  it("leaves a Premium bot's existing own computer alone: only a new one is refused", async () => {
    const existing = ownComputer();
    const db = planned("pro", [existing]);
    await expect(
      ensureComputerRecord(db, { ...own, botId: "b9" }),
    ).resolves.toBeDefined();
    expect(db.computer.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    await expect(ensureComputerRecord(planned("pro", [existing]), own)).rejects.toBeInstanceOf(
      SharedComputerLimitError,
    );
  });

  it("holds no one to it without plans: Free, or a server that does not bill", async () => {
    await expect(ensureComputerRecord(planned(null), own)).resolves.toBeDefined();
    const unbilled = planDb({ bills: false, tier: "pro" });
    await expect(
      assertOwnComputerAllowed(unbilled, { mode: "dedicated", spaceId: "space-1" }),
    ).resolves.toBeUndefined();
    await expect(
      assertOwnComputerAllowed({ computer: {} }, { mode: "dedicated", spaceId: "space-1" }),
    ).resolves.toBeUndefined();
  });
});
