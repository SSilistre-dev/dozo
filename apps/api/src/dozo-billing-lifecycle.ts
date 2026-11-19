import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { cancellationEmail, emailLocale, paymentFailedEmail, planEndingEmail } from "@rakazo/auth";
import type { ByokTier } from "@rakazo/contracts";
import { BYOK_TIERS } from "@rakazo/contracts";
import type { PlanGrant, PrismaClient } from "@rakazo/db";
import { hasBillingAccess, paidTierOf, planGrantOf, runAsSystem, tierInForce } from "@rakazo/db";
import { statusPlanEnd } from "./dozo-plan-end.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long before a plan ends without renewing its owners are told. */
export const PLAN_ENDING_NOTICE_DAYS = 3;
export const PLAN_ENDING_TASK = "dozo.plan-ending";

/** The reminder's job: the end it was queued for, which must still be the end when it runs. */
export type PlanEndingJob = { organizationId: string; endsAt: string };

/** The fork's job queue, as the lifecycle uses it. */
export interface LifecycleQueue {
  add(task: string, key: string, runAt: Date, payload: PlanEndingJob): Promise<void>;
  stop(): Promise<void>;
}

export interface BillingLifecycleDeps {
  prisma: PrismaClient;
  email: TransactionalEmailProvider;
  /** Billing in the web app, where every mail's button lands. */
  billingUrl: string;
  /** Builds the queue that runs `tasks`; absent where there is no durable queue (no reminders). */
  queue?: (tasks: Record<string, (payload: unknown) => Promise<void>>) => LifecycleQueue;
  onError: (error: unknown) => void;
  now?: () => Date;
}

const SUBSCRIPTION_SELECT = {
  status: true,
  subscriptionId: true,
  byokTier: true,
  trialEndsAt: true,
  currentPeriodEndsAt: true,
  cancelAtPeriodEnd: true,
} as const;

type Subscription = {
  status: string | null;
  subscriptionId: string | null;
  byokTier: string | null;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
};

type Owner = { id: string; email: string; name: string; locale: string | null };

/** Paid up again, so the next failed payment is a new one to tell. */
const SETTLED = new Set(["active", "trialing"]);

const planName = (tier: ByokTier | null) => (tier ? BYOK_TIERS[tier].name : null);

/**
 * Billing's transactional mails to the organization's owners, the members who manage billing: a
 * failed payment, a cancellation and a plan about to end. Each is read from the stored state, not
 * from the change that led there, so a redelivered or concurrent sync finds the same answer, and
 * an `email_sends` row per owner and occasion keeps it to one mail. A failed send gives its row
 * back, so the next sync (or the job's retry) sends it.
 *
 * - Past due: once, until the subscription is paid up again; a later failure is mailed again.
 * - Set to cancel at the end of its period: once per subscription, again only after it is resumed.
 * - The plan in force ends without renewing (a canceled subscription or a granted plan): a job
 *   queued for three days before the end, which mails only if that is still the end then.
 */
export function createBillingLifecycle(deps: BillingLifecycleDeps) {
  const { prisma } = deps;
  const now = () => deps.now?.() ?? new Date();
  const queue = deps.queue?.({ [PLAN_ENDING_TASK]: (payload) => remindPlanEnding(payload) });

  async function state(organizationId: string) {
    const [account, grant, owners] = await Promise.all([
      prisma.billingAccount.findUnique({ where: { organizationId }, select: SUBSCRIPTION_SELECT }),
      planGrantOf(prisma, organizationId),
      prisma.member.findMany({
        where: { organizationId, role: { contains: "owner" }, user: { deactivatedAt: null } },
        select: { user: { select: { id: true, email: true, name: true, locale: true } } },
      }),
    ]);
    return { account, grant, owners: owners.map((member) => member.user) };
  }

  /** Mails each owner who has not had `kind` yet; the first failure is thrown after the rest. */
  async function mailOnce(
    owners: Owner[],
    kind: string,
    build: (reader: Owner & { locale: string }) => Promise<TransactionalEmail>,
  ) {
    const failures: unknown[] = [];
    for (const owner of owners) {
      const claim = await prisma.emailSend.createMany({
        data: { userId: owner.id, kind },
        skipDuplicates: true,
      });
      if (claim.count === 0) continue;
      try {
        await deps.email.send(await build({ ...owner, locale: emailLocale(owner.locale) }));
      } catch (error) {
        await prisma.emailSend.deleteMany({ where: { userId: owner.id, kind } });
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  }

  /** Forgets `kind` for the owners, so it is mailed again the next time it happens. */
  async function forget(owners: Owner[], kind: string) {
    if (owners.length === 0) return;
    await prisma.emailSend.deleteMany({
      where: { kind, userId: { in: owners.map((owner) => owner.id) } },
    });
  }

  async function paymentFailed(organizationId: string, account: Subscription, owners: Owner[]) {
    const kind = `dozo-payment-failed:${organizationId}`;
    if (account.status === "past_due") {
      const plan = planName(paidTierOf(account)) ?? "Dozo";
      await mailOnce(owners, kind, (reader) => paymentFailedEmail(reader, plan, deps.billingUrl));
    } else if (account.status && SETTLED.has(account.status)) await forget(owners, kind);
  }

  async function canceled(account: Subscription, owners: Owner[]) {
    if (!account.subscriptionId || !hasBillingAccess(account.status)) return;
    const kind = `dozo-canceled:${account.subscriptionId}`;
    if (!account.cancelAtPeriodEnd) return forget(owners, kind);
    const end = statusPlanEnd(account, null, now());
    const plan = planName(paidTierOf(account));
    if (!end || !plan) return;
    await mailOnce(owners, kind, (reader) =>
      cancellationEmail(reader, { name: plan, endsAt: new Date(end.at) }, deps.billingUrl),
    );
  }

  /** Queues the reminder for the plan in force when it ends without renewing, far enough ahead. */
  async function scheduleReminder(
    organizationId: string,
    account: Subscription | null,
    grant: PlanGrant | null,
  ) {
    const end = statusPlanEnd(account, grant, now());
    if (!queue || !end || end.renews) return;
    const runAt = new Date(Date.parse(end.at) - PLAN_ENDING_NOTICE_DAYS * DAY_MS);
    // Too close to the end for a notice; a cancellation has already been confirmed by mail.
    if (runAt <= now()) return;
    await queue.add(PLAN_ENDING_TASK, `${PLAN_ENDING_TASK}:${organizationId}`, runAt, {
      organizationId,
      endsAt: end.at,
    });
  }

  async function remindPlanEnding(payload: unknown) {
    const job = payload as PlanEndingJob;
    await runAsSystem("mail an organization's owners that its plan ends", async () => {
      const { account, grant, owners } = await state(job.organizationId);
      const at = now();
      const end = statusPlanEnd(account, grant, at);
      // Renewed, extended, ended or moved since it was queued: a newer job has the new end.
      if (!end || end.renews || end.at !== job.endsAt) return;
      const name = end.fallsTo?.from ?? planName(tierInForce(paidTierOf(account), grant, at));
      if (!name) return;
      const next = end.fallsTo?.to ?? BYOK_TIERS.standard.name;
      await mailOnce(owners, `${PLAN_ENDING_TASK}:${job.organizationId}:${end.at}`, (reader) =>
        planEndingEmail(reader, { name, endsAt: new Date(end.at), next }, deps.billingUrl),
      );
    });
  }

  /** Runs `work` across tenants, reporting instead of throwing: billing never waits on a mail. */
  async function quietly(reason: string, work: () => Promise<void>) {
    try {
      await runAsSystem(reason, work);
    } catch (error) {
      deps.onError(error);
    }
  }

  return {
    /** After a sync stored the organization's subscription. */
    afterSync(organizationId: string): Promise<void> {
      return quietly("mail an organization's owners about its billing", async () => {
        const { account, grant, owners } = await state(organizationId);
        const results = await Promise.allSettled([
          account ? paymentFailed(organizationId, account, owners) : undefined,
          account ? canceled(account, owners) : undefined,
          scheduleReminder(organizationId, account, grant),
        ]);
        for (const result of results) if (result.status === "rejected") deps.onError(result.reason);
      });
    },
    /** After an admin gave or ended a plan by hand. */
    afterPlanChange(organizationId: string): Promise<void> {
      return quietly("queue the end of an organization's plan", async () => {
        const { account, grant } = await state(organizationId);
        await scheduleReminder(organizationId, account, grant);
      });
    },
    remindPlanEnding,
    async stop(): Promise<void> {
      await queue?.stop();
    },
  };
}

export type BillingLifecycle = ReturnType<typeof createBillingLifecycle>;
