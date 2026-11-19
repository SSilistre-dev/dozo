import { BYOK_TIERS, sandboxAllowanceHours } from "@rakazo/contracts";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { grantedAllowanceCents } from "./dozo-plan-grant.js";
import {
  changePlanQuota,
  codePlanQuota,
  computerHoursCents,
  readPlanLimits,
  readPlanQuotas,
} from "./dozo-plan-quotas.js";

// Runs on the branded tree only: the shared-space terms exist once the brand rules are applied.

const MB = 1024 * 1024;
type Row = { tier: string; sharedSpaceMb: unknown; computerHours: unknown };

/**
 * The quota rows and the security events, read through the model and written with the SQL the
 * module sends. A transaction commits both or neither, as Postgres does.
 */
function table(initial: Row[] = []) {
  let rows = initial.map((row) => ({ ...row }));
  const events: Record<string, unknown>[] = [];
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const failEvent = { next: false };
  const client = {
    dozoPlanQuota: { findMany: vi.fn(async () => rows.map((row) => ({ ...row }))) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, tier: string) =>
      sql(strings).includes("FOR UPDATE") ? rows.filter((row) => row.tier === tier) : [],
    ),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql(strings);
      if (text.includes("INSERT")) {
        const [tier] = values as [string];
        if (!rows.some((row) => row.tier === tier))
          rows.push({ tier, sharedSpaceMb: null, computerHours: null });
      } else if (text.includes("UPDATE")) {
        const [sharedSpaceMb, computerHours, , tier] = values as [unknown, unknown, string, string];
        rows = rows.map((row) =>
          row.tier === tier ? { tier, sharedSpaceMb, computerHours } : row,
        );
      }
      return 1;
    }),
    securityEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (failEvent.next) throw new Error("security_events is unavailable");
        events.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const [rowsBefore, eventsBefore] = [rows, events.length];
      try {
        return await work(client);
      } catch (error) {
        rows = rowsBefore;
        events.length = eventsBefore;
        throw error;
      }
    }),
  };
  return { client: client as unknown as PrismaClient, rows: () => rows, events, failEvent };
}

describe("reading the quotas", () => {
  it("follows the plans' terms before an admin set anything", async () => {
    const limits = await readPlanLimits(table().client);
    expect(limits.standard).toEqual({ sharedSpaceBytes: 500 * MB, computerAllowanceCents: 0 });
    expect(limits.pro.computerAllowanceCents).toBe(BYOK_TIERS.pro.computerAllowanceCents);
  });

  it("holds an admin's quota for its plan only, and leaves a cleared one to the terms", async () => {
    const limits = await readPlanLimits(
      table([
        { tier: "pro", sharedSpaceMb: 100, computerHours: 7 },
        { tier: "max", sharedSpaceMb: null, computerHours: null },
      ]).client,
    );
    expect(limits.pro).toEqual({
      sharedSpaceBytes: 100 * MB,
      computerAllowanceCents: computerHoursCents(7),
    });
    expect(sandboxAllowanceHours(limits.pro.computerAllowanceCents)).toBe(7);
    expect(limits.max).toEqual({
      sharedSpaceBytes: 5 * 1024 * MB,
      computerAllowanceCents: BYOK_TIERS.max.computerAllowanceCents,
    });
  });

  it("never guesses: a value out of bounds or an unknown plan follows the terms, and is logged", async () => {
    const sink = createTestSink();
    const previous = getLogger();
    installLogger(createLogger({ service: "test", level: "debug", sinks: [sink] }));
    try {
      const quotas = await readPlanQuotas(
        table([
          { tier: "pro", sharedSpaceMb: -1, computerHours: 1.5 },
          // A paid plan's hours are at least one: they are what its others are compared with.
          { tier: "max", sharedSpaceMb: null, computerHours: 0 },
          { tier: "gold", sharedSpaceMb: 1, computerHours: 1 },
        ]).client,
      );
      expect(quotas.pro).toEqual({ sharedSpaceMb: null, computerHours: null });
      expect(quotas.max).toEqual({ sharedSpaceMb: null, computerHours: null });
      expect(Object.keys(quotas)).toEqual(["standard", "pro", "max"]);
      expect(sink.events.map((event) => [event.level, event.message, event.quota])).toEqual([
        ["warn", "dozo.plan_quota.ignored", "sharedSpaceMb"],
        ["warn", "dozo.plan_quota.ignored", "computerHours"],
        ["warn", "dozo.plan_quota.ignored", "computerHours"],
      ]);
    } finally {
      installLogger(previous);
    }
  });

  it("never gives Free computer hours, even written into the table by hand", async () => {
    const limits = await readPlanLimits(
      table([{ tier: "standard", sharedSpaceMb: 100, computerHours: 40 }]).client,
    );
    expect(limits.standard).toEqual({ sharedSpaceBytes: 100 * MB, computerAllowanceCents: 0 });
  });

  it("states the terms in the units the page edits", () => {
    expect(codePlanQuota("standard")).toEqual({ sharedSpaceMb: 500, computerHours: 0 });
    expect(codePlanQuota("pro").computerHours).toBe(
      sandboxAllowanceHours(BYOK_TIERS.pro.computerAllowanceCents),
    );
  });

  it("gives a granted plan the hours an admin set for it", async () => {
    const endsAt = new Date(Date.now() + 86_400_000);
    const limits = await readPlanLimits(
      table([{ tier: "max", sharedSpaceMb: null, computerHours: 3 }]).client,
    );
    expect(grantedAllowanceCents({ tier: "max", endsAt }, new Date(), limits)).toBe(
      computerHoursCents(3),
    );
    expect(grantedAllowanceCents({ tier: "max", endsAt })).toBe(
      BYOK_TIERS.max.computerAllowanceCents,
    );
  });
});

describe("changing a quota", () => {
  it("records each quota that changed, with who, plan, from and to", async () => {
    const db = table();
    const { before, after } = await changePlanQuota(
      db.client,
      "pro",
      { sharedSpaceMb: 1024, computerHours: 50 },
      "admin-1",
    );
    expect(before).toEqual({ sharedSpaceMb: null, computerHours: null });
    expect(after).toEqual({ sharedSpaceMb: 1024, computerHours: 50 });
    expect(db.events.map((event) => [event.type, event.userId, event.metadata])).toEqual([
      [
        "deployment.settings.changed",
        "admin-1",
        { setting: "plan_quota", tier: "pro", quota: "sharedSpaceMb", from: null, to: 1024 },
      ],
      [
        "deployment.settings.changed",
        "admin-1",
        { setting: "plan_quota", tier: "pro", quota: "computerHours", from: null, to: 50 },
      ],
    ]);
    expect((await readPlanLimits(db.client)).pro.sharedSpaceBytes).toBe(1024 * MB);
  });

  it("keeps a quota the change leaves out, and records nothing for an unchanged one", async () => {
    const db = table([{ tier: "max", sharedSpaceMb: 10, computerHours: 5 }]);
    const { after } = await changePlanQuota(
      db.client,
      "max",
      { computerHours: null, sharedSpaceMb: 10 },
      "admin-1",
    );
    expect(after).toEqual({ sharedSpaceMb: 10, computerHours: null });
    expect(db.events).toHaveLength(1);
    expect(db.events[0]?.metadata).toMatchObject({ quota: "computerHours", from: 5, to: null });
  });

  it("never leaves a change without its record", async () => {
    const db = table();
    db.failEvent.next = true;
    await expect(
      changePlanQuota(db.client, "pro", { computerHours: 1 }, "admin-1"),
    ).rejects.toThrow();
    expect((await readPlanQuotas(db.client)).pro.computerHours).toBeNull();
  });
});
