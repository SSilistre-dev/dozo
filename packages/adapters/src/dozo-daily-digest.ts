import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineJobKey, routineWakeupJob } from "@rakazo/adapter-kit";
import {
  CARD_TITLE_ESCAPED_CHARACTERS,
  nextRoutineRunDateAcross,
  WAITING_ON_USER_RUN_STATUSES,
  wallClock,
  zonedDateTime,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  Prisma,
  runAsSystem,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { DOZO_DIGEST_ROUTINE_PROMPT } from "./dozo-daily-digest.prompt.js";

/**
 * The daily digest is a routine with a row in `dozo_daily_digest`: it wakes like any routine
 * (quiet hours and the 12-hour catch-up apply), but writes one message from saved data in its
 * bot's chat instead of starting a model run, and nothing on a day with nothing to say.
 */

/** The account's digest: which bot's chat it goes to, at which minute past local midnight. */
export interface DozoDailyDigest {
  botId: string;
  minute: number;
}

/** As read back: the minute is null once the routine's schedule was edited into another shape. */
export interface DozoDailyDigestState {
  botId: string;
  botName: string;
  minute: number | null;
}

const MAX_LINES = 5;
const ESCAPED = new RegExp(CARD_TITLE_ESCAPED_CHARACTERS, "g");

const TEXT = {
  en: {
    name: "Daily digest",
    yesterday: "Yesterday",
    waiting: "Waiting for you",
    today: "Today",
    done: (count: number) => `${count} done`,
    failed: (count: number) => `${count} failed`,
    more: (count: number) => `${count} more`,
  },
  tr: {
    name: "Günlük özet",
    yesterday: "Dün",
    waiting: "Sizi bekleyenler",
    today: "Bugün",
    done: (count: number) => `${count} bitti`,
    failed: (count: number) => `${count} başarısız`,
    more: (count: number) => `${count} tane daha`,
  },
};
type Language = keyof typeof TEXT;

function language(locale: string | null | undefined): Language {
  return locale?.toLowerCase().startsWith("tr") ? "tr" : "en";
}

/** The cron of a daily run at `minute` past local midnight. */
export function dozoDigestCron(minute: number): string {
  return `${minute % 60} ${Math.floor(minute / 60)} * * *`;
}

/** The minute a digest cron runs at, or null for one edited into something else. */
export function dozoDigestMinute(crons: string[]): number | null {
  const match = crons.length === 1 ? /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(crons[0] ?? "") : null;
  if (!match) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  return minute < 60 && hour < 24 ? hour * 60 + minute : null;
}

/** Local midnight of the day `at` falls on in `timeZone`, moved by `days`. */
function localMidnight(at: Date, timeZone: string, days: number): Date {
  const [year, month, day] = wallClock(at, timeZone).slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return zonedDateTime(date.toISOString().slice(0, 10), timeZone) ?? new Date(at.getTime());
}

export async function readDozoDailyDigest(
  prisma: PrismaClient,
  userId: string,
): Promise<DozoDailyDigestState | null> {
  const rows = await prisma.$queryRaw<
    Array<{ botId: string; botName: string; crons: string[]; active: boolean }>
  >`
    SELECT r."botId", b.name AS "botName", r.crons, r.active FROM dozo_daily_digest d
    JOIN routines r ON r.id = d."routineId" JOIN bots b ON b.id = r."botId"
    WHERE d."userId" = ${userId} AND r."userId" = ${userId}`;
  const row = rows[0];
  if (!row?.active) return null;
  return { botId: row.botId, botName: row.botName, minute: dozoDigestMinute(row.crons) };
}

interface SaveDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events?: Pick<ThreadEvents, "publishSpaceChange">;
  now?: () => Date;
}

/**
 * Turns the account's digest on, moves it, or turns it off. The bot is the caller's to check.
 * A digest on the same bot keeps its routine; another bot gets a new one in that bot's Space.
 */
export async function saveDozoDailyDigest(
  deps: SaveDeps,
  userId: string,
  digest: (DozoDailyDigest & { spaceId: string }) | null,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const changed = await runAsSystem("set an account's daily digest", () =>
    deps.prisma.$transaction(async (tx) => {
      // One save per account at a time, even its first: two would each make a routine.
      await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
      // A routine handed to someone else (its owner left the Space) is no longer this digest.
      const [current] = await tx.$queryRaw<
        Array<{ routineId: string; botId: string; spaceId: string }>
      >`
        SELECT r.id AS "routineId", r."botId", r."spaceId" FROM dozo_daily_digest d
        JOIN routines r ON r.id = d."routineId"
        WHERE d."userId" = ${userId} AND r."userId" = ${userId}`;
      const spaces = new Set<string>();
      let removed: string | null = null;
      if (current && current.botId !== digest?.botId) {
        await tx.routine.deleteMany({ where: { id: current.routineId } });
        spaces.add(current.spaceId);
        removed = current.routineId;
      }
      if (!digest) {
        await tx.$executeRaw`DELETE FROM dozo_daily_digest WHERE "userId" = ${userId}`;
        return { spaces, removed, wake: null };
      }
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { timezone: true, locale: true },
      });
      const timezone = user?.timezone ?? "UTC";
      const crons = [dozoDigestCron(digest.minute)];
      const nextRunAt = nextRoutineRunDateAcross(crons, now, now, timezone);
      const schedule = { crons, timezone, active: true, nextRunAt };
      let routineId: string;
      if (current && current.botId === digest.botId) {
        routineId = current.routineId;
        await tx.routine.update({ where: { id: routineId }, data: schedule });
      } else {
        const row = await tx.routine.create({
          data: {
            spaceId: digest.spaceId,
            botId: digest.botId,
            userId,
            name: TEXT[language(user?.locale)].name,
            prompt: DOZO_DIGEST_ROUTINE_PROMPT,
            notify: false,
            ...schedule,
          },
          select: { id: true },
        });
        routineId = row.id;
        await tx.$executeRaw`
          INSERT INTO dozo_daily_digest ("userId", "routineId") VALUES (${userId}, ${routineId})
          ON CONFLICT ("userId") DO UPDATE SET "routineId" = EXCLUDED."routineId"`;
      }
      spaces.add(digest.spaceId);
      return { spaces, removed, wake: nextRunAt ? { routineId, nextRunAt } : null };
    }),
  );
  for (const spaceId of changed.spaces)
    await bestEffort(
      "daily digest routine change",
      deps.events?.publishSpaceChange?.(spaceId, "routines"),
    );
  if (changed.removed)
    await bestEffort("daily digest old wakeup", deps.jobs.cancel(routineJobKey(changed.removed)));
  // After the commit, like every routine write; a failed enqueue is repaired by the reconciler.
  if (changed.wake)
    await bestEffort(
      "daily digest wakeup",
      deps.jobs.enqueue(routineWakeupJob(changed.wake.routineId, changed.wake.nextRunAt)),
    );
}

/** What a digest says; every list holds names only, never message content. */
export interface DozoDigestContent {
  yesterday: Array<{ bot: string; done: number; failed: number }>;
  waiting: Array<{ bot: string; count: number }>;
  today: Array<{ at: Date; bot: string; name: string }>;
}

function escaped(name: string): string {
  return name.replace(/\s+/g, " ").trim().replace(ESCAPED, "\\$&");
}

function capped<T>(items: T[], line: (item: T) => string, more: (count: number) => string) {
  const lines = items.slice(0, MAX_LINES).map((item) => `- ${line(item)}`);
  if (items.length > MAX_LINES) lines.push(`- ${more(items.length - MAX_LINES)}`);
  return lines;
}

/** The digest as one Markdown message, or null on a day with nothing in it. */
export function formatDozoDigest(
  content: DozoDigestContent,
  options: { locale: string | null; timeZone: string },
): string | null {
  const text = TEXT[language(options.locale)];
  const time = new Intl.DateTimeFormat(options.locale ?? "en", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: options.timeZone,
  });
  const sections: string[] = [];
  if (content.yesterday.length)
    sections.push(
      [
        `**${text.yesterday}**`,
        ...capped(
          content.yesterday,
          (row) =>
            `${escaped(row.bot)}: ${[
              row.done ? text.done(row.done) : "",
              row.failed ? text.failed(row.failed) : "",
            ]
              .filter(Boolean)
              .join(", ")}`,
          text.more,
        ),
      ].join("\n"),
    );
  if (content.waiting.length)
    sections.push(
      [
        `**${text.waiting}**`,
        ...capped(content.waiting, (row) => `${escaped(row.bot)}: ${row.count}`, text.more),
      ].join("\n"),
    );
  if (content.today.length)
    sections.push(
      [
        `**${text.today}**`,
        ...capped(
          content.today,
          (row) => `${time.format(row.at)} · ${escaped(row.bot)} · ${escaped(row.name)}`,
          text.more,
        ),
      ].join("\n"),
    );
  return sections.length ? sections.join("\n\n") : null;
}

/**
 * The account's own work in one Space: its runs started in the local day before `at` that have finished,
 * its runs waiting for an answer, and its timed routines due from `at` to local midnight.
 */
export async function collectDozoDigest(
  prisma: PrismaClient,
  input: { userId: string; spaceId: string; at: Date; timeZone: string; digestRoutineId: string },
): Promise<DozoDigestContent> {
  const todayStart = localMidnight(input.at, input.timeZone, 0);
  const yesterdayStart = localMidnight(input.at, input.timeZone, -1);
  const tomorrowStart = localMidnight(input.at, input.timeZone, 1);
  const mine = { userId: input.userId, spaceId: input.spaceId };
  const [finished, waiting, routines] = await Promise.all([
    prisma.run.groupBy({
      by: ["botId", "status"],
      where: {
        ...mine,
        status: { in: ["completed", "failed"] },
        createdAt: { gte: yesterdayStart, lt: todayStart },
      },
      _count: { _all: true },
    }),
    prisma.run.groupBy({
      by: ["botId"],
      where: { ...mine, status: { in: [...WAITING_ON_USER_RUN_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.routine.findMany({
      where: {
        ...mine,
        id: { not: input.digestRoutineId },
        active: true,
        watch: { equals: Prisma.DbNull },
        bot: { archivedAt: null },
        nextRunAt: { gte: input.at, lt: tomorrowStart },
      },
      select: { name: true, botId: true, nextRunAt: true },
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      take: MAX_LINES + 50,
    }),
  ]);
  const botIds = [...new Set([...finished, ...waiting, ...routines].map((row) => row.botId))];
  const bots = botIds.length
    ? await prisma.bot.findMany({
        where: { id: { in: botIds }, spaceId: input.spaceId },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const yesterday = new Map<string, { bot: string; done: number; failed: number }>();
  for (const row of finished) {
    const bot = names.get(row.botId);
    if (!bot) continue;
    const entry = yesterday.get(row.botId) ?? { bot, done: 0, failed: 0 };
    if (row.status === "completed") entry.done += row._count._all;
    else entry.failed += row._count._all;
    yesterday.set(row.botId, entry);
  }
  return {
    yesterday: [...yesterday.values()].sort((a, b) => b.done + b.failed - (a.done + a.failed)),
    waiting: waiting
      .flatMap((row) => {
        const bot = names.get(row.botId);
        return bot ? [{ bot, count: row._count._all }] : [];
      })
      .sort((a, b) => b.count - a.count),
    today: routines.flatMap((row) => {
      const bot = names.get(row.botId);
      return bot && row.nextRunAt ? [{ at: row.nextRunAt, bot, name: row.name }] : [];
    }),
  };
}

interface WakeDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: Pick<ThreadEvents, "notify" | "publishSpaceChange">;
}

/**
 * Called when a due routine is about to start a run. Returns false for every routine but a
 * digest. A digest takes this occurrence, writes its message when there is something to say,
 * and wakes again at its next time; the message's key keeps a repeated wake from writing twice.
 */
export async function dozoSendDailyDigest(
  deps: WakeDeps,
  routine: {
    id: string;
    spaceId: string;
    userId: string;
    prompt: string;
    crons: string[];
    timezone: string;
  },
  bot: { id: string },
  thread: { id: string },
  scheduledAt: Date,
): Promise<boolean> {
  // Only a routine that still asks for the digest is looked up: every other wake costs nothing,
  // and one whose prompt was edited in the Routines list runs as the routine it now is.
  if (routine.prompt !== DOZO_DIGEST_ROUTINE_PROMPT) return false;
  const [digest] = await deps.prisma.$queryRaw<Array<{ locale: string | null }>>`
    SELECT u.locale FROM dozo_daily_digest d JOIN "user" u ON u.id = d."userId"
    WHERE d."routineId" = ${routine.id} AND d."userId" = ${routine.userId}`;
  if (!digest) return false;
  const now = new Date();
  const nextRunAt = nextRoutineRunDateAcross(routine.crons, scheduledAt, now, routine.timezone);
  const at = new Date(Math.max(now.getTime(), scheduledAt.getTime()));
  const text = formatDozoDigest(
    await collectDozoDigest(deps.prisma, {
      userId: routine.userId,
      spaceId: routine.spaceId,
      at,
      timeZone: routine.timezone,
      digestRoutineId: routine.id,
    }),
    { locale: digest.locale, timeZone: routine.timezone },
  );
  const done = await deps.prisma.$transaction(async (tx) => {
    if (!(await spaceTakesWork(tx, routine.spaceId))) return null;
    const claimed = await tx.routine.updateMany({
      where: { id: routine.id, active: true, nextRunAt: scheduledAt },
      data: { lastRunAt: now, nextRunAt, ...(nextRunAt ? {} : { active: false }) },
    });
    if (claimed.count !== 1) return null;
    if (!text) return { seq: null };
    const blocks = [{ kind: "text" as const, text }];
    const message = await createThreadMessageInTransaction(tx, {
      threadId: thread.id,
      botId: bot.id,
      role: "bot",
      blocks,
      clientNonce: `dozo-digest:${routine.id}:${scheduledAt.toISOString()}`,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: routine.spaceId,
      threadId: thread.id,
      botId: bot.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { seq: event.seq };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  // Another wake or a save took this occurrence, and scheduled whatever comes next.
  if (!done) return true;
  if (done.seq !== null)
    await bestEffort("daily digest message", deps.events.notify(thread.id, done.seq));
  await bestEffort(
    "daily digest routine change",
    deps.events.publishSpaceChange?.(routine.spaceId, "routines"),
  );
  if (nextRunAt) await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
  return true;
}
