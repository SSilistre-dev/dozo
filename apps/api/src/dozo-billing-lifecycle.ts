import { randomUUID } from "node:crypto";
import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { EmailRecipientRejectedError } from "@rakazo/adapter-kit";
import { cancellationEmail, emailLocale, paymentFailedEmail, planEndingEmail } from "@rakazo/auth";
import type { ByokTier } from "@rakazo/contracts";
import { BYOK_TIERS } from "@rakazo/contracts";
import { deadlineSignal, MESSAGING_EMAIL_SUFFIX, retry, withAbort } from "@rakazo/core";
import type { PlanGrant } from "@rakazo/db";
import { hasBillingAccess, paidTierOf, runAsSystem, tierInForce } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type {
  BillingMailStore,
  BillingTx,
  ClaimedMail,
  MailDetails,
  MailKind,
  Notice,
  Subscription,
} from "./dozo-billing-mails.js";
import { statusPlanEnd } from "./dozo-plan-end.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How long before a plan ends without renewing its owners are told. */
const PLAN_ENDING_NOTICE_DAYS = 3;
export const PLAN_ENDING_TASK = "dozo.plan-ending";
export const BILLING_MAIL_TASK = "dozo.billing-mail";
export const BILLING_SWEEP_TASK = "dozo.billing-sweep";
/** The safety net: once an hour, Graphile runs it once across every API process. */
const BILLING_SWEEP_CRONTAB = `17 * * * * ${BILLING_SWEEP_TASK}`;
/** A send that has not finished by then is given up on; well inside a claim. */
const MAIL_SEND_DEADLINE_MS = MINUTE_MS;
/** A claim older than this belongs to a process that died. */
export const MAIL_CLAIM_MS = 5 * MINUTE_MS;
/** The backup job fires once a claim the sending process left behind can be taken over. */
const MAIL_BACKUP_MS = MAIL_CLAIM_MS + MINUTE_MS;
/** A pending mail with no backup job left after this long is given up on. */
const MAIL_ABANDONED_MS = DAY_MS;
/** One sweep looks at most this many organizations for a missing reminder; the next, the rest. */
const GAPS_PER_SWEEP = 500;
/** Settled mails are kept this long, then deleted. */
const MAIL_RETENTION_MS = 90 * DAY_MS;

/** The reminder's job: the end it was queued for, which must still be the end when it runs. */
export type PlanEndingJob = { organizationId: string; endsAt: string };

/** Runs the lifecycle's tasks on the durable queue until stopped. */
type LifecycleRunner = { stop(): Promise<void> };

export interface BillingLifecycleDeps {
  store: BillingMailStore;
  email: TransactionalEmailProvider;
  /** Billing in the web app, where every mail's button lands. */
  billingUrl: string;
  /** Starts the runner for `tasks` and the `crontab` lines; absent where there is no job queue. */
  queue?: (
    tasks: Record<string, (payload: unknown) => Promise<void>>,
    crontab: string,
  ) => LifecycleRunner;
  onError: (error: unknown) => void;
  now?: () => Date;
  /** Test seam for `MAIL_SEND_DEADLINE_MS`. */
  sendDeadlineMs?: number;
}

/** Paid up again, so the next failed payment is a new one to tell. */
const SETTLED = new Set(["active", "trialing"]);

const planName = (tier: ByokTier | null) => (tier ? BYOK_TIERS[tier].name : null);

/** A mail to record, and what the notice remembers once at least one owner gets it. */
type NewMail = { kind: MailKind; occasion: string; details: MailDetails; told?: Partial<Notice> };

/**
 * Billing's transactional mails to an organization's owners, the members who manage billing: a
 * failed payment, a cancellation, and a plan about to end. They are never what billing waits on:
 * every entry point reports its own failures instead of throwing, runs after the work it is about,
 * and is decided again from the stored state by the next sync, the backup jobs or the hourly sweep.
 *
 * What to mail is decided in one transaction that holds the organization's notice row, from the
 * subscription as stored then, so two syncs at once decide one after the other and a redelivered
 * one finds nothing new. The notice remembers what was told (an overdue payment until it is paid
 * up, the subscription that was set to cancel until it is resumed), and only once a mail went to at
 * least one owner, so an owner who verifies their address later still hears of it. The migration
 * that made it counts whatever was overdue or canceled at the time as told. The same transaction
 * records one mail per owner at that moment and a backup job for each; after commit the mails are
 * sent here without the caller waiting.
 *
 * A send claims its mail and is given `MAIL_SEND_DEADLINE_MS`. Sent, the mail is marked (tried a
 * few times) and its backup job removed; refused for good, it is marked failed and never tried
 * again; any other failure gives the claim back for the backup job. A claim left behind (a crash,
 * a send past its deadline, a mark that kept failing) is taken over after `MAIL_CLAIM_MS`. A mail
 * the provider accepted in such a case goes twice: the one double this allows.
 *
 * The reminder before a plan ends without renewing is one job per organization, queued with the
 * decision after a sync, after an admin's grant, and by the sweep for any organization missing
 * one. When it runs it mails only if that is still the end, then queues itself for the next end.
 */
export function createBillingLifecycle(deps: BillingLifecycleDeps) {
  const { store } = deps;
  const now = () => deps.now?.() ?? new Date();
  const sending = new Set<Promise<void>>();
  const runner = deps.queue?.(
    {
      [PLAN_ENDING_TASK]: (payload) => remindPlanEnding(payload as PlanEndingJob),
      [BILLING_MAIL_TASK]: async (payload) => {
        const { mailId } = payload as { mailId: string };
        const outcome = await runAsSystem("send a billing mail", () => deliver(mailId));
        // Another process holds a live claim: try again once it would have expired.
        if (outcome === "busy") throw new Error("Billing mail is being sent");
      },
      [BILLING_SWEEP_TASK]: () => sweep(),
    },
    BILLING_SWEEP_CRONTAB,
  );

  /** Records `mail` for each owner with its backup job; the new ids. */
  async function record(tx: BillingTx, organizationId: string, owners: string[], mail: NewMail) {
    const ids: string[] = [];
    for (const userId of owners) {
      const { kind, occasion, details } = mail;
      const id = await tx.addMail({ organizationId, userId, kind, occasion, details });
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

  /** What is new to tell, and what the notice forgets because it is over. */
  function decide(account: Subscription | null, told: Notice) {
    const notice = { ...told };
    const mails: NewMail[] = [];
    if (!account) return { notice, mails };
    if (account.status === "past_due") {
      if (!told.pastDueTold)
        mails.push({
          kind: "payment-failed",
          occasion: `payment-failed:${randomUUID()}`,
          details: { plan: planName(paidTierOf(account)) ?? "Dozo" },
          told: { pastDueTold: true },
        });
    } else if (account.status && SETTLED.has(account.status)) notice.pastDueTold = false;
    const subscriptionId = account.subscriptionId;
    if (subscriptionId && hasBillingAccess(account.status)) {
      if (!account.cancelAtPeriodEnd) notice.canceledSubscriptionId = null;
      else if (told.canceledSubscriptionId !== subscriptionId) {
        const end = statusPlanEnd(account, null, now());
        const plan = planName(paidTierOf(account));
        if (end && plan)
          mails.push({
            kind: "canceled",
            occasion: `canceled:${subscriptionId}:${randomUUID()}`,
            details: { plan, endsAt: end.at },
            told: { canceledSubscriptionId: subscriptionId },
          });
      }
    }
    return { notice, mails };
  }

  async function decideFor(organizationId: string) {
    return store.transaction(async (tx) => {
      const told = await tx.lockNotice(organizationId);
      const [account, grant] = await Promise.all([
        tx.subscription(organizationId),
        tx.grant(organizationId),
      ]);
      const { notice, mails } = decide(account, told);
      const ids: string[] = [];
      const owners = mails.length ? await tx.owners(organizationId) : [];
      // Told only once someone was mailed: with no owner to tell, the next sync asks again.
      if (owners.length)
        for (const mail of mails) {
          ids.push(...(await record(tx, organizationId, owners, mail)));
          Object.assign(notice, mail.told);
        }
      if (
        notice.pastDueTold !== told.pastDueTold ||
        notice.canceledSubscriptionId !== told.canceledSubscriptionId
      )
        await tx.saveNotice(organizationId, notice);
      await scheduleReminder(tx, organizationId, account, grant);
      return ids;
    });
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
    // A mark that keeps failing leaves the claim to expire, and the backup job sends again.
    const settle = (status: "sent" | "failed" | "skipped") =>
      retry(
        async () => {
          await store.finish(id, status);
          await store.removeJob(`${BILLING_MAIL_TASK}:${id}`);
        },
        { attempts: 3, delayMs: 200, retryable: () => true },
      );
    // Turned off, unverified or turned into a messaging contact since it was recorded.
    if (!mail.emailVerified || mail.deactivatedAt || mail.email.endsWith(MESSAGING_EMAIL_SUFFIX)) {
      await settle("skipped");
      return "done";
    }
    const deadline = deadlineSignal(deps.sendDeadlineMs ?? MAIL_SEND_DEADLINE_MS);
    try {
      const message = await build(mail);
      await withAbort(deps.email.send(message), deadline, "Billing mail send timed out");
    } catch (error) {
      if (error instanceof EmailRecipientRejectedError) {
        await settle("failed");
        deps.onError(error);
        return "done";
      }
      // Past its deadline the send may still land: the claim stays and expires instead.
      if (!deadline.aborted) await store.release(id);
      throw error;
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

  /** Runs `work` across tenants and reports what fails: a mail never fails what it is about. */
  async function quietly(reason: string, work: () => Promise<void>) {
    try {
      await runAsSystem(reason, work);
    } catch (error) {
      deps.onError(error);
    }
  }

  /** `checked`: the sweep looked, so the organization goes behind the others next time. */
  async function queueReminder(organizationId: string, { checked = false } = {}) {
    await store.transaction(async (tx) => {
      const [account, grant] = await Promise.all([
        tx.subscription(organizationId),
        tx.grant(organizationId),
      ]);
      await scheduleReminder(tx, organizationId, account, grant);
      if (checked) await tx.markReminderChecked(organizationId);
    });
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
        // Renewed, extended, ended or moved since it was queued: only the end it was queued for.
        const name =
          end && !end.renews && end.at === job.endsAt
            ? (end.fallsTo?.from ?? planName(tierInForce(paidTierOf(account), grant, at)))
            : null;
        const recorded =
          end && name
            ? await record(tx, job.organizationId, await tx.owners(job.organizationId), {
                kind: "plan-ending",
                occasion: `plan-ending:${job.organizationId}:${end.at}`,
                details: {
                  plan: name,
                  endsAt: end.at,
                  next: end.fallsTo?.to ?? BYOK_TIERS.standard.name,
                },
              })
            : [];
        await scheduleReminder(tx, job.organizationId, account, grant);
        return recorded;
      }),
    );
    deliverSoon(ids);
  }

  /**
   * The slow safety net: queues the reminder an organization should have and has not (its
   * queueing failed), gives up on mails whose backup job ran out of tries, and deletes settled
   * mails past their retention.
   */
  async function sweep() {
    await runAsSystem("sweep billing mails", async () => {
      const gaps = await store.reminderGaps(`${PLAN_ENDING_TASK}:`, GAPS_PER_SWEEP);
      for (const organizationId of gaps)
        await queueReminder(organizationId, { checked: true }).catch(deps.onError);
      const abandoned = await store.failAbandoned(`${BILLING_MAIL_TASK}:`, MAIL_ABANDONED_MS);
      if (abandoned.length)
        getLogger().warn("billing mails given up after their retries", {
          "billing_mail.count": abandoned.length,
        });
      await store.purge(MAIL_RETENTION_MS);
    });
  }

  return {
    /** After a sync of the customer's subscription finished; reports failures, never throws. */
    afterSync(customerId: string): Promise<void> {
      return quietly("decide an organization's billing mails", async () => {
        const organizationId = await store.organizationOf(customerId);
        if (organizationId) deliverSoon(await decideFor(organizationId));
      });
    },
    /** After an admin gave or ended a plan; reports failures, never throws. */
    afterPlanChange(organizationId: string): Promise<void> {
      return quietly("queue the end of an organization's plan", () =>
        queueReminder(organizationId),
      );
    },
    remindPlanEnding,
    deliver,
    sweep,
    /** Stops the runner, then waits for the mails being sent. */
    async stop(): Promise<void> {
      await runner?.stop();
      await Promise.allSettled([...sending]);
    },
  };
}
