import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { EmailRecipientRejectedError } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import type { Prisma } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingLifecycleDeps, PlanEndingJob } from "./dozo-billing-lifecycle.js";
import {
  BILLING_MAIL_TASK,
  createBillingLifecycle,
  MAIL_CLAIM_MS,
  PLAN_ENDING_TASK,
} from "./dozo-billing-lifecycle.js";
import type {
  BillingMailStore,
  BillingTx,
  MailDetails,
  MailKind,
  Notice,
  Subscription,
} from "./dozo-billing-mails.js";

// Runs on the branded tree only: the plan names (Free, Premium, Premium Plus) come from the brand
// rules. The store's SQL, its row lock and the migration's seed are tested against PostgreSQL in
// dozo-billing-mails.postgres.test.ts.

const NOW = new Date("2026-11-19T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY);

const subscription = (changes: Partial<Subscription> = {}): Subscription => ({
  status: "active",
  subscriptionId: "sub_1",
  byokTier: "pro",
  trialEndsAt: null,
  currentPeriodEndsAt: inDays(20),
  cancelAtPeriodEnd: false,
  ...changes,
});

type Reader = {
  email: string;
  name: string;
  locale: string | null;
  emailVerified: boolean;
  deactivatedAt: Date | null;
};
type Mail = {
  organizationId: string;
  userId: string;
  occasion: string;
  kind: MailKind;
  details: MailDetails;
  status: string;
  claimedAt: number | null;
};

/**
 * The store in memory, with what a transaction gives: the notice lock is held until the
 * transaction ends, and its writes land only when it commits.
 */
function memoryStore() {
  const db = {
    account: null as Subscription | null,
    grant: null as { tier: string; endsAt: Date } | null,
    owners: ["ada"],
    readers: new Map<string, Reader>([
      [
        "ada",
        {
          email: "ada@example.com",
          name: "Ada",
          locale: null,
          emailVerified: true,
          deactivatedAt: null,
        },
      ],
    ]),
    notices: new Map<string, Notice>(),
    mails: new Map<string, Mail>(),
    jobs: new Map<string, { task: string; runAt: Date; payload: object }>(),
    removed: [] as string[],
    clock: NOW.getTime(),
  };
  /** Each organization's lock: the end of the transaction that holds it. */
  const locks = new Map<string, Promise<void>>();
  let ids = 0;
  type Tx = { writes: Array<() => void>; unlock: Array<() => void> };
  const within = (tx: Tx): BillingTx => ({
    async lockNotice(organizationId) {
      const previous = locks.get(organizationId) ?? Promise.resolve();
      const mine = deferred<void>();
      locks.set(
        organizationId,
        previous.then(() => mine.promise),
      );
      tx.unlock.push(() => mine.resolve());
      await previous;
      return {
        ...(db.notices.get(organizationId) ?? { pastDueTold: false, canceledSubscriptionId: null }),
      };
    },
    async saveNotice(organizationId, notice) {
      tx.writes.push(() => db.notices.set(organizationId, notice));
    },
    subscription: async () => (db.account ? { ...db.account } : null),
    grant: async () => db.grant,
    owners: async () => db.owners.filter((id) => db.readers.get(id)?.emailVerified),
    async addMail(mail) {
      const taken = [...db.mails.values()].some(
        (row) => row.userId === mail.userId && row.occasion === mail.occasion,
      );
      if (taken) return null;
      const id = `mail-${++ids}`;
      tx.writes.push(() => db.mails.set(id, { ...mail, status: "pending", claimedAt: null }));
      return id;
    },
    async addJob(task, key, runAt, payload) {
      tx.writes.push(() => db.jobs.set(key, { task, runAt, payload }));
    },
  });
  const store: BillingMailStore = {
    async transaction(work) {
      const tx: Tx = { writes: [], unlock: [] };
      try {
        const result = await work(within(tx));
        for (const write of tx.writes) write();
        return result;
      } finally {
        for (const unlock of tx.unlock) unlock();
      }
    },
    // The caller's transaction commits after; here its writes land as they are made.
    within: () => {
      const tx: Tx = { writes: [], unlock: [] };
      const reads = within(tx);
      const flush = <T>(result: T) => {
        for (const write of tx.writes.splice(0)) write();
        return result;
      };
      return {
        ...reads,
        addJob: (...args) => reads.addJob(...args).then(flush),
      };
    },
    async claim(id, staleMs) {
      const mail = db.mails.get(id);
      if (mail?.status !== "pending") return null;
      if (mail.claimedAt !== null && mail.claimedAt >= db.clock - staleMs) return "busy";
      mail.claimedAt = db.clock;
      const reader = db.readers.get(mail.userId);
      if (!reader) return null;
      return { kind: mail.kind, details: mail.details, ...reader };
    },
    async finish(id, status) {
      const mail = db.mails.get(id);
      if (mail) mail.status = status;
    },
    async release(id) {
      const mail = db.mails.get(id);
      if (mail) mail.claimedAt = null;
    },
    async removeJob(key) {
      db.removed.push(key);
      db.jobs.delete(key);
    },
  };
  return { db, store };
}

let db: ReturnType<typeof memoryStore>["db"];
let store: BillingMailStore;
let sent: TransactionalEmail[];
let send: ReturnType<typeof vi.fn>;
let errors: unknown[];
let tasks: Record<string, (payload: unknown) => Promise<void>>;
let runner: { stop: ReturnType<typeof vi.fn<() => Promise<void>>> };

function lifecycle({ withQueue = true } = {}) {
  ({ db, store } = memoryStore());
  const deps: BillingLifecycleDeps = {
    store,
    email: { send, describe: () => ({ id: "test" }) } as never,
    billingUrl: "https://app.example.com/app?settings=billing",
    onError: (error) => {
      errors.push(error);
    },
    now: () => new Date(db.clock),
  };
  if (withQueue)
    deps.queue = (given) => {
      tasks = given;
      return runner;
    };
  return createBillingLifecycle(deps);
}

/** Lets the sends started after commit settle. */
async function settled(billing: ReturnType<typeof lifecycle>) {
  await billing.stop();
}

const statuses = () => [...db.mails.values()].map((mail) => mail.status);

beforeEach(() => {
  sent = [];
  errors = [];
  send = vi.fn(async (message: TransactionalEmail) => {
    sent.push(message);
  });
  runner = { stop: vi.fn(async () => undefined) };
});

describe("a failed payment", () => {
  it("is mailed to each owner once, however often the sync sees it", async () => {
    const billing = lifecycle();
    db.owners.push("bob");
    db.readers.set("bob", {
      email: "bob@example.com",
      name: "",
      locale: "tr",
      emailVerified: true,
      deactivatedAt: null,
    });
    db.account = subscription({ status: "past_due" });
    await billing.afterSync("org");
    await billing.afterSync("org");
    await settled(billing);
    expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([
      ["ada@example.com", "Your Dozo payment didn't go through"],
      ["bob@example.com", "Dozo ödemeniz alınamadı"],
    ]);
    expect(sent[0]?.text).toContain("Your last payment for Premium didn't go through.");
    expect(sent[0]?.html).toContain("https://app.example.com/app?settings=billing");
    expect(statuses()).toEqual(["sent", "sent"]);
    // Each sent mail's backup job is gone.
    expect(db.removed).toEqual([`${BILLING_MAIL_TASK}:mail-1`, `${BILLING_MAIL_TASK}:mail-2`]);
    expect(errors).toEqual([]);
  });

  it("is decided once when two syncs see it at the same time", async () => {
    const billing = lifecycle();
    db.account = subscription({ status: "past_due" });
    await Promise.all([billing.afterSync("org"), billing.afterSync("org")]);
    await settled(billing);
    expect(sent).toHaveLength(1);
  });

  it("is decided from the subscription as it is when the lock is held", async () => {
    const billing = lifecycle();
    db.account = subscription({ status: "past_due" });
    // The first sync holds the lock while the payment goes through; the second then reads it.
    const decided = deferred<void>();
    const gate = deferred<void>();
    const original = store.transaction.bind(store);
    store.transaction = async (work) =>
      original(async (tx) => {
        const result = await work(tx);
        decided.resolve();
        await gate.promise;
        return result;
      });
    const first = billing.afterSync("org");
    const second = billing.afterSync("org");
    await decided.promise;
    db.account = subscription({ status: "active" });
    gate.resolve();
    await Promise.all([first, second]);
    await settled(billing);
    expect(sent).toHaveLength(1);
    expect(db.notices.get("org")?.pastDueTold).toBe(false);
  });

  it("is mailed again only after the subscription was paid up in between", async () => {
    const billing = lifecycle();
    for (const status of ["past_due", "unpaid", "past_due", "active", "past_due"]) {
      db.account = subscription({ status });
      await billing.afterSync("org");
    }
    await settled(billing);
    expect(sent).toHaveLength(2);
  });

  it("is not mailed when it was already overdue before this shipped", async () => {
    const billing = lifecycle();
    // The migration's seed: overdue at the time counts as told.
    db.notices.set("org", { pastDueTold: true, canceledSubscriptionId: "sub_1" });
    db.account = subscription({ status: "past_due", cancelAtPeriodEnd: true });
    await billing.afterSync("org");
    await settled(billing);
    expect(sent).toEqual([]);
  });

  it("names the product when the subscription has no plan tier", async () => {
    const billing = lifecycle();
    db.account = subscription({ status: "past_due", byokTier: null });
    await billing.afterSync("org");
    await settled(billing);
    expect(sent[0]?.text).toContain("Your last payment for Dozo didn't go through.");
  });

  it("goes only to owners who were owners when it happened, with a verified address", async () => {
    const billing = lifecycle();
    db.readers.set("eve", {
      email: "eve@example.com",
      name: "",
      locale: null,
      emailVerified: false,
      deactivatedAt: null,
    });
    db.owners.push("eve");
    db.account = subscription({ status: "past_due" });
    await billing.afterSync("org");
    db.owners.push("cy");
    db.readers.set("cy", {
      email: "cy@example.com",
      name: "",
      locale: null,
      emailVerified: true,
      deactivatedAt: null,
    });
    await billing.afterSync("org");
    await settled(billing);
    expect(sent.map((mail) => mail.to)).toEqual(["ada@example.com"]);
  });
});

describe("sending", () => {
  it("does not make the sync wait for the mail", async () => {
    const billing = lifecycle();
    const delivery = deferred<void>();
    send.mockImplementationOnce(() => delivery.promise);
    db.account = subscription({ status: "past_due" });
    await billing.afterSync("org");
    expect(statuses()).toEqual(["pending"]);
    delivery.resolve();
    await settled(billing);
    expect(statuses()).toEqual(["sent"]);
  });

  it("gives the claim back on a failure, and the backup job sends it", async () => {
    const billing = lifecycle();
    send.mockRejectedValueOnce(new Error("provider down"));
    db.account = subscription({ status: "past_due" });
    await billing.afterSync("org");
    await settled(billing);
    expect(errors).toEqual([new Error("provider down")]);
    const job = db.jobs.get(`${BILLING_MAIL_TASK}:mail-1`);
    expect(job?.runAt).toEqual(new Date(NOW.getTime() + MAIL_CLAIM_MS + 60_000));
    await tasks[BILLING_MAIL_TASK]?.(job?.payload);
    expect(sent).toHaveLength(1);
    expect(statuses()).toEqual(["sent"]);
  });

  it("never tries again an address the provider refused", async () => {
    const billing = lifecycle();
    const refused = new EmailRecipientRejectedError("no such mailbox");
    send.mockRejectedValueOnce(refused);
    db.account = subscription({ status: "past_due" });
    await billing.afterSync("org");
    await settled(billing);
    expect(statuses()).toEqual(["failed"]);
    expect(db.jobs.size).toBe(0);
    expect(errors).toEqual([refused]);
    await expect(billing.deliver("mail-1")).resolves.toBe("done");
    expect(send).toHaveBeenCalledOnce();
  });

  it("leaves a live claim alone and takes over one its process left behind", async () => {
    const billing = lifecycle();
    const hung = deferred<void>();
    send.mockImplementationOnce(() => hung.promise);
    db.account = subscription({ status: "past_due" });
    await billing.afterSync("org");
    // The process holding the claim is still sending: the backup job waits.
    await expect(tasks[BILLING_MAIL_TASK]?.({ mailId: "mail-1" })).rejects.toThrow("being sent");
    // It died: once the claim is old enough, the backup job sends.
    db.clock += MAIL_CLAIM_MS + 1;
    await tasks[BILLING_MAIL_TASK]?.({ mailId: "mail-1" });
    expect(sent).toHaveLength(1);
  });

  it("skips an owner turned off since the mail was recorded", async () => {
    const billing = lifecycle();
    const hold = deferred<void>();
    send.mockImplementationOnce(() => hold.promise);
    db.account = subscription({ status: "past_due" });
    await billing.afterSync("org");
    db.mails.get("mail-1")!.claimedAt = null;
    db.readers.set("ada", { ...db.readers.get("ada")!, deactivatedAt: NOW });
    await billing.deliver("mail-1");
    expect(statuses()).toEqual(["skipped"]);
    hold.resolve();
  });
});

describe("a cancellation", () => {
  it("is confirmed once with the day the plan lasts until", async () => {
    const billing = lifecycle();
    db.account = subscription({ cancelAtPeriodEnd: true });
    await billing.afterSync("org");
    await billing.afterSync("org");
    await settled(billing);
    expect(sent.map((mail) => mail.subject)).toEqual(["Your Dozo subscription is canceled"]);
    expect(sent[0]?.text).toContain("You keep Premium until December 9, 2026.");
    expect(sent[0]?.headers?.["List-Unsubscribe"]).toBeUndefined();
  });

  it("is in Turkish for a Turkish reader", async () => {
    const billing = lifecycle();
    db.readers.set("ada", { ...db.readers.get("ada")!, locale: "tr" });
    db.account = subscription({ cancelAtPeriodEnd: true });
    await billing.afterSync("org");
    await settled(billing);
    expect(sent[0]?.subject).toBe("Dozo aboneliğiniz iptal edildi");
    expect(sent[0]?.text).toContain("9 Aralık 2026 tarihine kadar Premium planınız devam eder.");
    expect(sent[0]?.text).toContain("Merhaba Ada,");
  });

  it("is confirmed again after the subscription was resumed and canceled again", async () => {
    const billing = lifecycle();
    for (const cancelAtPeriodEnd of [true, false, true]) {
      db.account = subscription({ cancelAtPeriodEnd });
      await billing.afterSync("org");
    }
    await settled(billing);
    expect(sent).toHaveLength(2);
  });

  it("is not confirmed once ended, without a plan tier, or past its period", async () => {
    const billing = lifecycle();
    db.account = subscription({ status: "canceled", cancelAtPeriodEnd: true });
    await billing.afterSync("org");
    db.account = subscription({ subscriptionId: "sub_2", cancelAtPeriodEnd: true, byokTier: null });
    await billing.afterSync("org");
    db.account = subscription({
      subscriptionId: "sub_3",
      cancelAtPeriodEnd: true,
      currentPeriodEndsAt: inDays(-1),
    });
    await billing.afterSync("org");
    await settled(billing);
    expect(sent).toEqual([]);
  });
});

describe("the reminder before a plan ends", () => {
  const reminder = () => db.jobs.get(`${PLAN_ENDING_TASK}:org`);

  it("is queued with the sync for three days before a canceled subscription ends", async () => {
    const billing = lifecycle();
    db.account = subscription({ cancelAtPeriodEnd: true });
    await billing.afterSync("org");
    expect(reminder()).toEqual({
      task: PLAN_ENDING_TASK,
      runAt: inDays(17),
      payload: { organizationId: "org", endsAt: inDays(20).toISOString() },
    });
  });

  it("is queued in the admin's transaction, and not for a plan that renews", async () => {
    const billing = lifecycle();
    const tx = {} as Prisma.TransactionClient;
    db.grant = { tier: "max", endsAt: inDays(10) };
    await billing.afterPlanChange(tx, "org");
    expect(reminder()?.runAt).toEqual(inDays(7));
    db.jobs.clear();
    db.grant = null;
    db.account = subscription();
    await billing.afterPlanChange(tx, "org");
    expect(reminder()).toBeUndefined();
  });

  it("looks again just after an end too close for a notice", async () => {
    const billing = lifecycle();
    db.grant = { tier: "pro", endsAt: inDays(2) };
    await billing.afterPlanChange({} as Prisma.TransactionClient, "org");
    expect(reminder()?.runAt).toEqual(new Date(inDays(2).getTime() + 60_000));
  });

  it("mails once that a granted plan returns to Free", async () => {
    const billing = lifecycle();
    db.grant = { tier: "max", endsAt: inDays(3) };
    const job = { organizationId: "org", endsAt: inDays(3).toISOString() };
    await tasks[PLAN_ENDING_TASK]?.(job);
    await billing.remindPlanEnding(job);
    await settled(billing);
    expect(sent.map((mail) => mail.subject)).toEqual([
      "Your Premium Plus plan ends on November 22, 2026",
    ]);
    expect(sent[0]?.text).toContain("On November 22, 2026 your account moves to Free.");
  });

  it("reaches the canceled subscription's end after a granted plan above it ends", async () => {
    const billing = lifecycle();
    db.account = subscription({ cancelAtPeriodEnd: true, currentPeriodEndsAt: inDays(60) });
    db.grant = { tier: "max", endsAt: inDays(30) };
    await billing.afterSync("org");
    expect(reminder()?.runAt).toEqual(inDays(27));
    // Day 27: the grant's mail, then a look just after it ends.
    db.clock = inDays(27).getTime();
    await billing.remindPlanEnding(reminder()?.payload as PlanEndingJob);
    expect(reminder()?.runAt).toEqual(new Date(inDays(30).getTime() + 60_000));
    // Just after day 30: the subscription's end is next, three days ahead of it.
    db.clock = inDays(30).getTime() + 60_000;
    await billing.remindPlanEnding(reminder()?.payload as PlanEndingJob);
    expect(reminder()?.runAt).toEqual(inDays(57));
    db.clock = inDays(57).getTime();
    await billing.remindPlanEnding(reminder()?.payload as PlanEndingJob);
    await settled(billing);
    const reminders = sent.filter((mail) => mail.subject.includes("plan ends"));
    expect(reminders.map((mail) => [mail.subject, mail.text.includes(" moves to Free.")])).toEqual([
      ["Your Premium Plus plan ends on December 19, 2026", false],
      ["Your Premium plan ends on January 18, 2027", true],
    ]);
  });

  it("names the paid plan that follows a granted one above it, in Turkish", async () => {
    const billing = lifecycle();
    db.readers.set("ada", { ...db.readers.get("ada")!, locale: "tr-TR" });
    db.account = subscription();
    db.grant = { tier: "max", endsAt: inDays(3) };
    await billing.remindPlanEnding({ organizationId: "org", endsAt: inDays(3).toISOString() });
    await settled(billing);
    expect(sent[0]?.subject).toBe("Premium Plus planınız 22 Kasım 2026 tarihinde bitiyor");
    expect(sent[0]?.text).toContain("22 Kasım 2026 tarihinde hesabınız Premium planına geçecek.");
  });

  it("mails nothing when the end moved, renewed, was removed, or names no plan", async () => {
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
    await settled(billing);
    expect(sent).toEqual([]);
  });
});

describe("failures and the queue", () => {
  it("fail the sync when the decision cannot be recorded, and record nothing", async () => {
    const billing = lifecycle();
    db.account = subscription({ status: "past_due", cancelAtPeriodEnd: true });
    const original = store.transaction.bind(store);
    store.transaction = (work) =>
      original((tx) =>
        work({ ...tx, addJob: async () => Promise.reject(new Error("queue down")) }),
      );
    await expect(billing.afterSync("org")).rejects.toThrow("queue down");
    expect(db.mails.size).toBe(0);
    expect(db.notices.size).toBe(0);
  });

  it("stop the runner on stop, and run without one", async () => {
    let billing = lifecycle();
    await billing.stop();
    expect(runner.stop).toHaveBeenCalledOnce();
    billing = lifecycle({ withQueue: false });
    db.account = subscription({ status: "past_due" });
    await billing.afterSync("org");
    await settled(billing);
    expect(sent).toHaveLength(1);
  });
});
