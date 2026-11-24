import type { ProductAnalytics } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RouterContext } from "./routes/context.js";
import { windowCounter } from "./window-counter.js";

/**
 * The fork's product events (`DOZO_ANALYTICS_EVENTS`). Each is reported after the work it
 * describes and never holds it up; without analytics configured nothing is read or sent. Each
 * carries an id the analytics provider deduplicates on, since the same change can be seen twice.
 */

/** How long a sign-up form may have been open before the account it made. */
export const DOZO_SIGNUP_FORM_MS = 60 * 60 * 1000;
/** What one member's apps may report per minute; past it the report is refused. */
export const DOZO_EVENTS_PER_MINUTE = 30;
/** The same report from the same member within this window is sent once. */
export const DOZO_EVENT_REPEAT_MS = 10 * 60_000;
/** How many members this process remembers as already having their first bot or message. */
export const DOZO_FIRSTS_REMEMBERED = 10_000;

type Deps = { prisma: PrismaClient; analytics?: ProductAnalytics };

/**
 * What the apps report: checked, then sent as the caller's own. Each process limits how many one
 * member reports a minute and sends a repeated report once per window; with several instances
 * the limit is per instance.
 */
export function dozoEventsRoutes(ctx: RouterContext, now: () => number = Date.now) {
  const { deps, authed } = ctx;
  const perMinute = windowCounter(60_000, now);
  const repeats = windowCounter(DOZO_EVENT_REPEAT_MS, now);
  return {
    dozoEvents: {
      track: authed.dozoEvents.track.handler(async ({ context, input }) => {
        const { analytics, prisma } = deps;
        const userId = context.actor.userId;
        if (!analytics) return { ok: true as const };
        if (perMinute(`user:${userId}`) > DOZO_EVENTS_PER_MINUTE)
          throw new ClientError("TOO_MANY_REQUESTS", "Too many events");
        // A sign-up start is one per account whatever time it carries.
        if (repeats(`${userId}:${input.name}`) > 1) return { ok: true as const };
        // Only a form opened shortly before this account was made started it.
        const opened = new Date(input.startedAt);
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { createdAt: true },
        });
        const before = user ? user.createdAt.getTime() - opened.getTime() : -1;
        if (before >= 0 && before <= DOZO_SIGNUP_FORM_MS)
          analytics.capture(userId, { name: "signup_started" }, { id: userId, at: opened });
        return { ok: true as const };
      }),
    },
  };
}

type FirstKind = "bot" | "message";
const remembered = new Set<string>();

/**
 * Records that the member made their first of a kind, once: true only for the call whose insert
 * added the row, however many race. A member this process saw recorded is not asked again, so a
 * member's later messages cost nothing.
 */
async function recordFirst(prisma: PrismaClient, userId: string, kind: FirstKind) {
  const key = `${kind}:${userId}`;
  if (remembered.has(key)) return false;
  const added = await runAsSystem(
    `record a member's first ${kind}`,
    () =>
      prisma.$executeRaw`
      INSERT INTO dozo_member_firsts ("userId", "kind") VALUES (${userId}, ${kind})
      ON CONFLICT DO NOTHING`,
  );
  // Oldest first: past the limit the member remembered longest is asked again next time.
  if (remembered.size >= DOZO_FIRSTS_REMEMBERED)
    remembered.delete(remembered.values().next().value!);
  remembered.add(key);
  return added === 1;
}

/** Forgets every member this process remembered; for tests. */
export function forgetRecordedFirsts() {
  remembered.clear();
}

/** After a bot is created: reports the member's first, once. */
export async function dozoFirstBot(deps: Deps, actor: Actor): Promise<void> {
  const { analytics, prisma } = deps;
  if (!analytics) return;
  await bestEffort(
    "first bot analytics",
    (async () => {
      if (await recordFirst(prisma, actor.userId, "bot"))
        analytics.capture(
          actor.userId,
          { name: "first_bot_created" },
          { id: actor.userId, at: new Date() },
        );
    })(),
  );
}

/**
 * Bot creation that reports the member's first bot: every path that creates one goes through the
 * repositories this wraps (the app's own, templates, imports, copies, account import).
 */
export function dozoReportingRepos<
  R extends { createBot(actor: Actor, ...rest: never[]): Promise<unknown> },
>(repos: R, deps: Deps): R {
  if (!deps.analytics) return repos;
  return {
    ...repos,
    async createBot(actor: Actor, ...rest: never[]) {
      const bot = await repos.createBot(actor, ...rest);
      void dozoFirstBot(deps, actor);
      return bot;
    },
  };
}

/** After a member's message is saved: reports their first, once. */
export async function dozoFirstMessage(
  deps: Deps,
  actor: Actor,
  message: { createdAt: Date },
): Promise<void> {
  const { analytics, prisma } = deps;
  if (!analytics) return;
  await bestEffort(
    "first message analytics",
    (async () => {
      if (await recordFirst(prisma, actor.userId, "message"))
        analytics.capture(
          actor.userId,
          { name: "first_message_sent" },
          { id: actor.userId, at: message.createdAt },
        );
    })(),
  );
}
