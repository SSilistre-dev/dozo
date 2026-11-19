import type { TransactionalEmail } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleQueue, PlanEndingJob } from "./dozo-billing-lifecycle.js";
import { createBillingLifecycle, PLAN_ENDING_TASK } from "./dozo-billing-lifecycle.js";

// Runs on the branded tree only: the plan names (Free, Premium, Premium Plus) and the grant table
// come from the brand rules.

const NOW = new Date("2026-11-19T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY);

type Account = {
  status: string | null;
  subscriptionId: string | null;
  byokTier: string | null;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
};
type Owner = { id: string; email: string; name: string; locale: string | null };

const subscription = (changes: Partial<Account> = {}): Account => ({
  status: "active",
  subscriptionId: "sub_1",
  byokTier: "pro",
  trialEndsAt: null,
  currentPeriodEndsAt: inDays(20),
  cancelAtPeriodEnd: false,
  ...changes,
});

/** The rows the lifecycle reads and writes, in memory. */
function store() {
  const db = {
    account: null as Account | null,
    grant: null as { tier: string; endsAt: Date } | null,
    owners: [{ id: "ada", email: "ada@example.com", name: "Ada", locale: null }] as Owner[],
    sends: new Set<string>(),
    reads: 0,
  };
  const prisma = {
    billingAccount: {
      findUnique: vi.fn(async () => {
        db.reads += 1;
        return db.account;
      }),
    },
    dozoPlanGrant: { findUnique: vi.fn(async () => db.grant) },
    member: { findMany: vi.fn(async () => db.owners.map((user) => ({ user }))) },
    emailSend: {
      createMany: vi.fn(async ({ data }: { data: { userId: string; kind: string } }) => {
        const key = `${data.userId} ${data.kind}`;
        if (db.sends.has(key)) return { count: 0 };
        db.sends.add(key);
        return { count: 1 };
      }),
      deleteMany: vi.fn(
        async ({ where }: { where: { kind: string; userId: string | { in: string[] } } }) => {
          const users = typeof where.userId === "string" ? [where.userId] : where.userId.in;
          for (const user of users) db.sends.delete(`${user} ${where.kind}`);
          return { count: 0 };
        },
      ),
    },
  };
  return { db, prisma: prisma as unknown as PrismaClient, raw: prisma };
}

let db: ReturnType<typeof store>["db"];
let raw: ReturnType<typeof store>["raw"];
let sent: TransactionalEmail[];
let send: ReturnType<typeof vi.fn>;
let errors: unknown[];
let queued: Array<{ task: string; key: string; runAt: Date; payload: PlanEndingJob }>;
let tasks: Record<string, (payload: unknown) => Promise<void>>;
let queue: LifecycleQueue & { stop: ReturnType<typeof vi.fn> };

function lifecycle({ withQueue = true } = {}) {
  const built = store();
  db = built.db;
  raw = built.raw;
  return createBillingLifecycle({
    prisma: built.prisma,
    email: { send, describe: () => ({ id: "test" }) } as never,
    billingUrl: "https://app.example.com/app?settings=billing",
    onError: (error) => errors.push(error),
    now: () => NOW,
    ...(withQueue
      ? {
          queue: (given) => {
            tasks = given;
            return queue;
          },
        }
      : {}),
  });
}

beforeEach(() => {
  sent = [];
  errors = [];
  queued = [];
  send = vi.fn(async (message: TransactionalEmail) => {
    sent.push(message);
  });
  queue = {
    add: vi.fn(async (task, key, runAt, payload) => {
      queued.push({ task, key, runAt, payload });
    }),
    stop: vi.fn(async () => undefined),
  };
});

describe("a failed payment", () => {
  it("is mailed to the owners once, however often the sync sees it", async () => {
    const billing = lifecycle();
    db.owners.push({ id: "bob", email: "bob@example.com", name: "", locale: "tr" });
    db.account = subscription({ status: "past_due" });
    await billing.afterSync("org");
    await billing.afterSync("org");
    expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([
      ["ada@example.com", "Your Dozo payment didn't go through"],
      ["bob@example.com", "Dozo ödemeniz alınamadı"],
    ]);
    expect(sent[0]?.text).toContain("Your last payment for Premium didn't go through.");
    expect(sent[0]?.html).toContain("https://app.example.com/app?settings=billing");
    expect(errors).toEqual([]);
  });

  it("is mailed again only after the subscription was paid up in between", async () => {
    const billing = lifecycle();
    db.account = subscription({ status: "past_due" });
    await billing.afterSync("org");
    db.account = subscription({ status: "unpaid" });
    await billing.afterSync("org");
    db.account = subscription({ status: "past_due" });
    await billing.afterSync("org");
    expect(sent).toHaveLength(1);
    db.account = subscription({ status: "active" });
    await billing.afterSync("org");
    db.account = subscription({ status: "past_due" });
    await billing.afterSync("org");
    expect(sent).toHaveLength(2);
  });

  it("names the product when the subscription has no plan tier", async () => {
    const billing = lifecycle();
    db.account = subscription({ status: "past_due", byokTier: null });
    await billing.afterSync("org");
    expect(sent[0]?.text).toContain("Your last payment for Dozo didn't go through.");
  });

  it("is given back when the send fails, so the next sync sends it", async () => {
    const billing = lifecycle();
    db.account = subscription({ status: "past_due" });
    send.mockRejectedValueOnce(new Error("provider down"));
    await billing.afterSync("org");
    expect(errors).toEqual([new Error("provider down")]);
    expect(db.sends.size).toBe(0);
    await billing.afterSync("org");
    expect(sent).toHaveLength(1);
  });

  it("is nothing to an organization without owners", async () => {
    const billing = lifecycle();
    db.owners = [];
    db.account = subscription({ status: "active" });
    await billing.afterSync("org");
    expect(raw.emailSend.deleteMany).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("is not mailed for an organization without a subscription", async () => {
    const billing = lifecycle();
    await billing.afterSync("org");
    expect(sent).toEqual([]);
    expect(queued).toEqual([]);
  });
});

describe("a cancellation", () => {
  it("is confirmed once with the day the plan lasts until", async () => {
    const billing = lifecycle();
    db.account = subscription({ cancelAtPeriodEnd: true });
    await billing.afterSync("org");
    await billing.afterSync("org");
    expect(sent.map((mail) => mail.subject)).toEqual(["Your Dozo subscription is canceled"]);
    expect(sent[0]?.text).toContain("You keep Premium until December 9, 2026.");
    expect(sent[0]?.headers?.["List-Unsubscribe"]).toBeUndefined();
  });

  it("is in Turkish for a Turkish reader", async () => {
    const billing = lifecycle();
    db.owners = [{ id: "ada", email: "ada@example.com", name: "Ada", locale: "tr" }];
    db.account = subscription({ cancelAtPeriodEnd: true });
    await billing.afterSync("org");
    expect(sent[0]?.subject).toBe("Dozo aboneliğiniz iptal edildi");
    expect(sent[0]?.text).toContain("9 Aralık 2026 tarihine kadar Premium planınız devam eder.");
    expect(sent[0]?.text).toContain("Merhaba Ada,");
  });

  it("is confirmed again after the subscription was resumed and canceled again", async () => {
    const billing = lifecycle();
    db.account = subscription({ cancelAtPeriodEnd: true });
    await billing.afterSync("org");
    db.account = subscription();
    await billing.afterSync("org");
    db.account = subscription({ cancelAtPeriodEnd: true });
    await billing.afterSync("org");
    expect(sent).toHaveLength(2);
  });

  it("is not confirmed once the subscription has ended, or without a plan tier", async () => {
    const billing = lifecycle();
    db.account = subscription({ status: "canceled", cancelAtPeriodEnd: true });
    await billing.afterSync("org");
    db.account = subscription({ cancelAtPeriodEnd: true, byokTier: null });
    await billing.afterSync("org");
    db.account = subscription({ cancelAtPeriodEnd: true, currentPeriodEndsAt: inDays(-1) });
    await billing.afterSync("org");
    expect(sent).toEqual([]);
  });
});

describe("the reminder before a plan ends", () => {
  it("is queued for three days before a canceled subscription ends", async () => {
    const billing = lifecycle();
    db.account = subscription({ cancelAtPeriodEnd: true });
    await billing.afterSync("org");
    expect(queued).toEqual([
      {
        task: PLAN_ENDING_TASK,
        key: `${PLAN_ENDING_TASK}:org`,
        runAt: inDays(17),
        payload: { organizationId: "org", endsAt: inDays(20).toISOString() },
      },
    ]);
  });

  it("is queued when an admin grants a plan, and not for one that renews", async () => {
    const billing = lifecycle();
    db.grant = { tier: "max", endsAt: inDays(10) };
    await billing.afterPlanChange("org");
    expect(queued.map((job) => job.runAt)).toEqual([inDays(7)]);
    db.grant = null;
    db.account = subscription();
    await billing.afterPlanChange("org");
    expect(queued).toHaveLength(1);
  });

  it("is not queued when the end is three days away or nearer, or without a queue", async () => {
    let billing = lifecycle();
    db.grant = { tier: "pro", endsAt: inDays(3) };
    await billing.afterPlanChange("org");
    expect(queued).toEqual([]);
    billing = lifecycle({ withQueue: false });
    db.grant = { tier: "pro", endsAt: inDays(10) };
    await billing.afterPlanChange("org");
    expect(queued).toEqual([]);
    await billing.stop();
  });

  it("mails once that a granted plan returns to Free", async () => {
    const billing = lifecycle();
    db.grant = { tier: "max", endsAt: inDays(3) };
    const job = { organizationId: "org", endsAt: inDays(3).toISOString() };
    await tasks[PLAN_ENDING_TASK]?.(job);
    await billing.remindPlanEnding(job);
    expect(sent.map((mail) => mail.subject)).toEqual([
      "Your Premium Plus plan ends on November 22, 2026",
    ]);
    expect(sent[0]?.text).toContain("On November 22, 2026 your account moves to Free.");
  });

  it("names the paid plan that follows a granted one above it, in Turkish", async () => {
    const billing = lifecycle();
    db.owners = [{ id: "ada", email: "ada@example.com", name: "Ada", locale: "tr-TR" }];
    db.account = subscription();
    db.grant = { tier: "max", endsAt: inDays(3) };
    await billing.remindPlanEnding({ organizationId: "org", endsAt: inDays(3).toISOString() });
    expect(sent[0]?.subject).toBe("Premium Plus planınız 22 Kasım 2026 tarihinde bitiyor");
    expect(sent[0]?.text).toContain("22 Kasım 2026 tarihinde hesabınız Premium planına geçecek.");
  });

  it("mails nothing when the end moved, renewed or was removed since it was queued", async () => {
    const billing = lifecycle();
    const job = { organizationId: "org", endsAt: inDays(3).toISOString() };
    db.grant = { tier: "pro", endsAt: inDays(30) };
    await billing.remindPlanEnding(job);
    db.grant = null;
    await billing.remindPlanEnding(job);
    db.account = subscription({ currentPeriodEndsAt: inDays(3) });
    await billing.remindPlanEnding(job);
    db.account = subscription({
      byokTier: null,
      cancelAtPeriodEnd: true,
      currentPeriodEndsAt: inDays(3),
    });
    await billing.remindPlanEnding(job);
    expect(sent).toEqual([]);
  });

  it("fails the job when a mail could not be sent, so the queue retries it", async () => {
    const billing = lifecycle();
    db.grant = { tier: "pro", endsAt: inDays(3) };
    send.mockRejectedValueOnce(new Error("provider down"));
    const job = { organizationId: "org", endsAt: inDays(3).toISOString() };
    await expect(billing.remindPlanEnding(job)).rejects.toThrow("provider down");
    await billing.remindPlanEnding(job);
    expect(sent).toHaveLength(1);
  });
});

describe("failures", () => {
  it("report a failed queue and still mail what is due", async () => {
    const billing = lifecycle();
    queue.add = vi.fn(async () => {
      throw new Error("queue down");
    });
    db.account = subscription({ cancelAtPeriodEnd: true });
    await billing.afterSync("org");
    expect(errors).toEqual([new Error("queue down")]);
    expect(sent).toHaveLength(1);
  });

  it("report a failed read instead of failing the sync", async () => {
    const billing = lifecycle();
    raw.billingAccount.findUnique.mockRejectedValueOnce(new Error("database down"));
    await expect(billing.afterSync("org")).resolves.toBeUndefined();
    raw.billingAccount.findUnique.mockRejectedValueOnce(new Error("database down"));
    await expect(billing.afterPlanChange("org")).resolves.toBeUndefined();
    expect(errors).toHaveLength(2);
  });

  it("stop the queue on stop", async () => {
    const billing = lifecycle();
    await billing.stop();
    expect(queue.stop).toHaveBeenCalledOnce();
  });
});
