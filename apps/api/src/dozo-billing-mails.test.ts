import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { sqlMailStore } from "./dozo-billing-mails.js";

// What each call sends to the database. The SQL itself runs against PostgreSQL in
// dozo-billing-mails.postgres.test.ts.

type Call = { sql: string; values: unknown[] };

function fakePrisma(answers: unknown[][] = []) {
  const calls: Call[] = [];
  const raw = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
  };
  const prisma = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      raw(strings, ...values);
      return 1;
    }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      raw(strings, ...values);
      return answers.shift() ?? [];
    }),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(prisma)),
    billingAccount: { findUnique: vi.fn(async () => ({ status: "active" })) },
    dozoPlanGrant: { findUnique: vi.fn(async () => null) },
    member: { findMany: vi.fn(async () => [{ userId: "ada" }]) },
  };
  return { prisma: prisma as unknown as PrismaClient, raw: prisma, calls };
}

describe("sqlMailStore", () => {
  it("locks the organization's notice, writing a new one that has told nothing", async () => {
    const { prisma, calls } = fakePrisma([[{ pastDueTold: true, canceledSubscriptionId: null }]]);
    const notice = await sqlMailStore(prisma, { jobs: true }).transaction((tx) =>
      tx.lockNotice("org"),
    );
    expect(notice).toEqual({ pastDueTold: true, canceledSubscriptionId: null });
    expect(calls.map((call) => call.sql)).toEqual([
      'INSERT INTO "dozo_billing_notices" ("organizationId") VALUES (?) ON CONFLICT ("organizationId") DO NOTHING',
      'SELECT "pastDueTold", "canceledSubscriptionId" FROM "dozo_billing_notices" WHERE "organizationId" = ? FOR UPDATE',
    ]);
    const empty = fakePrisma();
    await expect(
      sqlMailStore(empty.prisma, { jobs: true }).transaction((tx) => tx.lockNotice("org")),
    ).rejects.toThrow("not written");
  });

  it("saves the notice, reads the subscription, grant and owners", async () => {
    const { prisma, raw, calls } = fakePrisma();
    const tx = sqlMailStore(prisma, { jobs: true }).within(prisma as never);
    await tx.saveNotice("org", { pastDueTold: false, canceledSubscriptionId: "sub_1" });
    expect(calls[0]?.values).toEqual([false, "sub_1", "org"]);
    expect(await tx.subscription("org")).toEqual({ status: "active" });
    expect(await tx.grant("org")).toBeNull();
    expect(await tx.owners("org")).toEqual(["ada"]);
    expect(raw.member.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org",
        role: { contains: "owner" },
        user: {
          emailVerified: true,
          deactivatedAt: null,
          NOT: { email: { endsWith: "@messaging.invalid" } },
        },
      },
      select: { userId: true },
    });
  });

  it("records a mail once per owner and occasion", async () => {
    const { prisma, calls } = fakePrisma([[{ id: "mail-1" }], []]);
    const tx = sqlMailStore(prisma, { jobs: true }).within(prisma as never);
    const mail = {
      organizationId: "org",
      userId: "ada",
      occasion: "plan-ending:org:2026-12-09",
      kind: "plan-ending" as const,
      details: { plan: "Premium", endsAt: "2026-12-09", next: "Free" },
    };
    expect(await tx.addMail(mail)).toBe("mail-1");
    expect(await tx.addMail(mail)).toBeNull();
    expect(calls[0]?.sql).toContain('ON CONFLICT ("userId", "occasion") DO NOTHING');
    expect(calls[0]?.values.slice(1)).toEqual([
      "org",
      "ada",
      "plan-ending:org:2026-12-09",
      "plan-ending",
      '{"plan":"Premium","endsAt":"2026-12-09","next":"Free"}',
    ]);
  });

  it("queues and removes jobs only where there is a queue", async () => {
    const queued = fakePrisma();
    const store = sqlMailStore(queued.prisma, { jobs: true });
    await store
      .within(queued.prisma as never)
      .addJob("dozo.test", "dozo.test:org", new Date("2026-11-22T12:00:00.000Z"), { id: 1 });
    await store.removeJob("dozo.test:org");
    expect(queued.calls.map((call) => [call.sql.split("(")[0], call.values])).toEqual([
      [
        "SELECT graphile_worker.add_job",
        ["dozo.test", '{"id":1}', "2026-11-22T12:00:00.000Z", 10, "dozo.test:org"],
      ],
      ["SELECT graphile_worker.remove_job", ["dozo.test:org"]],
    ]);
    const none = fakePrisma();
    const without = sqlMailStore(none.prisma, { jobs: false });
    await without.within(none.prisma as never).addJob("dozo.test", "k", new Date(), {});
    await without.removeJob("k");
    expect(none.calls).toEqual([]);
  });

  it("claims a pending mail, says busy while another claim is live, and settles it", async () => {
    const reader = {
      kind: "payment-failed",
      details: { plan: "Premium" },
      email: "ada@example.com",
      name: "Ada",
      locale: null,
      emailVerified: true,
      deactivatedAt: null,
    };
    const { prisma, calls } = fakePrisma([
      [reader],
      [],
      [{ status: "pending" }],
      [],
      [{ status: "sent" }],
    ]);
    const store = sqlMailStore(prisma, { jobs: true });
    expect(await store.claim("mail-1", 300_000)).toEqual(reader);
    expect(calls[0]?.values).toEqual(["mail-1", 300]);
    expect(await store.claim("mail-1", 300_000)).toBe("busy");
    expect(await store.claim("mail-1", 300_000)).toBeNull();
    await store.finish("mail-1", "sent");
    await store.release("mail-1");
    expect(calls.slice(-2).map((call) => call.values)).toEqual([["sent", "mail-1"], ["mail-1"]]);
  });
});
