import { randomUUID } from "node:crypto";
import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { EmailRecipientRejectedError } from "@rakazo/adapter-kit";
import { cancellationEmail, emailLocale, paymentFailedEmail, planEndingEmail } from "@rakazo/auth";
import type { ByokTier } from "@rakazo/contracts";
import { BYOK_TIERS } from "@rakazo/contracts";
import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import type { PlanGrant, Prisma } from "@rakazo/db";
import { hasBillingAccess, paidTierOf, runAsSystem, tierInForce } from "@rakazo/db";
import type {
  BillingMailStore,
  BillingTx,
  ClaimedMail,
  MailDetails,
  MailKind,
  Subscription,
} from "./dozo-billing-mails.js";
import { statusPlanEnd } from "./dozo-plan-end.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How long before a plan ends without renewing its owners are told. */
export const PLAN_ENDING_NOTICE_DAYS = 3;
export const PLAN_ENDING_TASK = "dozo.plan-ending";
export const BILLING_MAIL_TASK = "dozo.billing-mail";
/** A claim older than this belongs to a process that died; a send is bounded well below it. */
export const MAIL_CLAIM_MS = 5 * MINUTE_MS;
/** The backup job fires once a claim the sending process left behind can be taken over. */
const MAIL_BACKUP_MS = MAIL_CLAIM_MS + MINUTE_MS;

/** The reminder's job: the end it was queued for, which must still be the end when it runs. */
export type PlanEndingJob = { organizationId: string; endsAt: string };

/** Runs the lifecycle's tasks on the durable queue until stopped. */
export type LifecycleRunner = { stop(): Promise<void> };

export interface BillingLifecycleDeps {
  store: BillingMailStore;
  email: TransactionalEmailProvider;
  /** Billing in the web app, where every mail's button lands. */
  billingUrl: string;
  /** Starts the runner for `tasks`; absent where there is no durable queue. */
  queue?: (tasks: Record<string, (payload: unknown) => Promise<void>>) => LifecycleRunner;
  onError: (error: unknown) => void;
  now?: () => Date;
}

/** Paid up again, so the next failed payment is a new one to tell. */
const SETTLED = new Set(["active", "trialing"]);

const planName = (tier: ByokTier | null) => (tier ? BYOK_TIERS[tier].name : null);

type NewMail = { kind: MailKind; occasion: string; details: MailDetails };

/**
 * Billing's transactional mails to an organization's owners, the members who manage billing: a
 * failed payment, a cancellation, and a plan about to end.
 *
 * What to mail is decided in one transaction that holds the organization's notice row, from the
 * subscription as stored then, so two syncs at once decide one after the other and a redelivered
 * one finds nothing new. The notice remembers what was told (an overdue payment until it is paid
 * up, the subscription that was set to cancel until it is resumed); the migration that made it
 * counts whatever was overdue or canceled at the time as told, so only later changes are mailed.
 * The same transaction records one mail per owner at that moment and a backup job for each; after
 * commit the mails are sent here without the caller waiting.
 *
 * A send claims its mail first. Sent, it is marked and its backup job removed; refused for good
 * (the address is rejected), it is marked failed and never tried again; any other failure gives
 * the claim back and the backup job tries again. A process that dies holding a claim leaves it
 * for `MAIL_CLAIM_MS`, after which the backup job takes it over. That leaves one rare double: a
 * mail the provider accepted while the process died, or timed out on, before it was marked sent.
 *
 * The reminder before a plan ends without renewing is one job per organization, queued in the
 * transaction that changed the end (a sync, or an admin's grant). When it runs it mails only if
 * that is still the end, then queues itself for the end in force after that.
 */
export function createBillingLifecycle(deps: BillingLifecycleDeps) {
  const { store } = deps;
  const now = () => deps.now?.() ?? new Date();
  const sending = new Set<Promise<void>>();
  const runner = deps.queue?.({
    [PLAN_ENDING_TASK]: (payload) => remindPlanEnding(payload as PlanEndingJob),
    [BILLING_MAIL_TASK]: async (payload) => {
      const { mailId } = payload as { mailId: string };
      // Another process holds a live claim: try again once it would have expired.
      const outcome = await runAsSystem("send a billing mail", () => deliver(mailId));
      if (outcome === "busy") throw new Error("Billing mail is being sent");
    },
  });

  /** Records `mails` for the organization's owners, each with its backup job; the new ids. */
  async function record(tx: BillingTx, organizationId: string, mails: NewMail[]) {
    const ids: string[] = [];
    if (mails.length === 0) return ids;
    const owners = await tx.owners(organizationId);
    for (const mail of mails)
      for (const userId of owners) {
        const id = await tx.addMail({ organizationId, userId, ...mail });
        if (!id) continue;
        ids.push(id);
        const runAt = new Date(now().getTime() + MAIL_BACKUP_MS);
        await tx.addJob(BILLING_MAIL_TASK, `${BILLING_MAIL_TASK}:${id}`, runAt, { mailId: id });
      }
    return ids;
  }

  /**
   * Queues the reminder for the end of the plan in force when it does not renew: three days
   * ahead, or, when that has passed, just after the end, to find the end that follows it.
   */
  async function scheduleReminder(
    tx: BillingTx,
    organizationId: string,
    account: Subscription | null,
    grant: PlanGrant | null,
  ) {
    const end = statusPlanEnd(account, grant, now());
    if (!end || end.renews) return;
    const at = Date.parse(end.at);
    const notice = at - PLAN_ENDING_NOTICE_DAYS * DAY_MS;
    const runAt = new Date(notice > now().getTime() ? notice : at + MINUTE_MS);
    const job: PlanEndingJob = { organizationId, endsAt: end.at };
    await tx.addJob(PLAN_ENDING_TASK, `${PLAN_ENDING_TASK}:${organizationId}`, runAt, job);
  }

  /** What is new to tell, and the notice that remembers it. */
  function decide(
    account: Subscription | null,
    told: { pastDueTold: boolean; canceledSubscriptionId: string | null },
  ) {
    const notice = { ...told };
    const mails: NewMail[] = [];
    if (!account) return { notice, mails };
    if (account.status === "past_due") {
      if (!told.pastDueTold) {
        notice.pastDueTold = true;
        const plan = planName(paidTierOf(account)) ?? "Dozo";
        mails.push({
          kind: "payment-failed",
          occasion: `payment-failed:${randomUUID()}`,
          details: { plan },
        });
      }
    } else if (account.status && SETTLED.has(account.status)) notice.pastDueTold = false;
    const subscriptionId = account.subscriptionId;
    if (subscriptionId && hasBillingAccess(account.status)) {
      if (!account.cancelAtPeriodEnd) notice.canceledSubscriptionId = null;
      else if (told.canceledSubscriptionId !== subscriptionId) {
        notice.canceledSubscriptionId = subscriptionId;
        const end = statusPlanEnd(account, null, now());
        const plan = planName(paidTierOf(account));
        if (end && plan)
          mails.push({
            kind: "canceled",
            occasion: `canceled:${subscriptionId}:${randomUUID()}`,
            details: { plan, endsAt: end.at },
          });
      }
    }
    return { notice, mails };
  }

  function build(mail: ClaimedMail): Promise<TransactionalEmail> {
    const reader = { email: mail.email, name: mail.name, locale: emailLocale(mail.locale) };
    const { plan, endsAt, next } = mail.details;
    if (mail.kind === "payment-failed") return paymentFailedEmail(reader, plan, deps.billingUrl);
    const end = new Date(endsAt ?? "");
    if (mail.kind === "canceled")
      return cancellationEmail(reader, { name: plan, endsAt: end }, deps.billingUrl);
    return planEndingEmail(reader, { name: plan, endsAt: end, next: next ?? "" }, deps.billingUrl);
  }

  /** Sends one recorded mail if no live claim holds it; "busy" while one does. */
  async function deliver(id: string): Promise<"done" | "busy"> {
    const mail = await store.claim(id, MAIL_CLAIM_MS);
    if (mail === "busy") return "busy";
    if (!mail) return "done";
    const settle = async (status: "sent" | "failed" | "skipped") => {
      await store.finish(id, status);
      await store.removeJob(`${BILLING_MAIL_TASK}:${id}`);
    };
    // Turned off, unverified or turned into a messaging contact since it was recorded.
    if (!mail.emailVerified || mail.deactivatedAt || mail.email.endsWith(MESSAGING_EMAIL_SUFFIX)) {
      await settle("skipped");
      return "done";
    }
    try {
      await deps.email.send(await build(mail));
    } catch (error) {
      if (!(error instanceof EmailRecipientRejectedError)) {
        await store.release(id);
        throw error;
      }
      await settle("failed");
      deps.onError(error);
      return "done";
    }
    await settle("sent");
    return "done";
  }

  /** Sends after commit without the caller waiting; the backup jobs cover a failure. */
  function deliverSoon(ids: string[]) {
    for (const id of ids) {
      const send = runAsSystem("send a billing mail", () => deliver(id)).then(
        () => undefined,
        deps.onError,
      );
      sending.add(send);
      void send.finally(() => sending.delete(send));
    }
  }

  async function remindPlanEnding(job: PlanEndingJob) {
    const ids = await runAsSystem("mail an organization's owners that its plan ends", () =>
      store.transaction(async (tx) => {
        const [account, grant] = await Promise.all([
          tx.subscription(job.organizationId),
          tx.grant(job.organizationId),
        ]);
        const at = now();
        const end = statusPlanEnd(account, grant, at);
        const mails: NewMail[] = [];
        // Renewed, extended, ended or moved since it was queued: only the end it was queued for.
        if (end && !end.renews && end.at === job.endsAt) {
          const name = end.fallsTo?.from ?? planName(tierInForce(paidTierOf(account), grant, at));
          if (name)
            mails.push({
              kind: "plan-ending",
              occasion: `plan-ending:${job.organizationId}:${end.at}`,
              details: {
                plan: name,
                endsAt: end.at,
                next: end.fallsTo?.to ?? BYOK_TIERS.standard.name,
              },
            });
        }
        const recorded = await record(tx, job.organizationId, mails);
        await scheduleReminder(tx, job.organizationId, account, grant);
        return recorded;
      }),
    );
    deliverSoon(ids);
  }

  return {
    /**
     * After a sync stored the organization's subscription. A failure is thrown, so the sync fails
     * and the provider's redelivery decides again; sending never makes the caller wait.
     */
    async afterSync(organizationId: string): Promise<void> {
      const ids = await runAsSystem("decide an organization's billing mails", () =>
        store.transaction(async (tx) => {
          const told = await tx.lockNotice(organizationId);
          const [account, grant] = await Promise.all([
            tx.subscription(organizationId),
            tx.grant(organizationId),
          ]);
          const { notice, mails } = decide(account, told);
          if (
            notice.pastDueTold !== told.pastDueTold ||
            notice.canceledSubscriptionId !== told.canceledSubscriptionId
          )
            await tx.saveNotice(organizationId, notice);
          const recorded = await record(tx, organizationId, mails);
          await scheduleReminder(tx, organizationId, account, grant);
          return recorded;
        }),
      );
      deliverSoon(ids);
    },
    /** Inside the transaction where an admin gave or ended a plan: queues the reminder with it. */
    async afterPlanChange(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
      const within = store.within(tx);
      const [account, grant] = await Promise.all([
        within.subscription(organizationId),
        within.grant(organizationId),
      ]);
      await scheduleReminder(within, organizationId, account, grant);
    },
    remindPlanEnding,
    deliver,
    /** Stops the runner, then waits for the mails being sent. */
    async stop(): Promise<void> {
      await runner?.stop();
      await Promise.allSettled([...sending]);
    },
  };
}

export type BillingLifecycle = ReturnType<typeof createBillingLifecycle>;
