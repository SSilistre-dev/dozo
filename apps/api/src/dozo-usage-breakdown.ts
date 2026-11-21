import type { DozoUsageGroup, DozoUsageGrouping } from "@rakazo/contracts";
import { isValidTimeZone } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

/**
 * The caller's usage records summed per model, bot and routine at once, so one read serves every
 * grouping. A routine is the one that started the record's top-level run. Counts say how many
 * records carried each figure, so a group's total can read as unknown when one lacks it.
 */
export type UsageCell = {
  provider: string;
  model: string;
  botId: string | null;
  botName: string | null;
  deletedBotName: string | null;
  routineId: string | null;
  routineName: string | null;
  routineBotName: string | null;
  routineUnknown: boolean;
  calls: number;
  inputCount: number;
  inputTokens: number;
  outputCount: number;
  outputTokens: number;
  totalCount: number;
  totalTokens: number;
  costCount: number;
  costUsd: number;
  /** Set on the cells of the `day` reader: the account-zone day, `YYYY-MM-DD`. */
  day?: string;
  /** Set on the cells of the `person` reader. */
  userId?: string;
  userName?: string | null;
  userEmail?: string | null;
};

/**
 * Reads the cells. Usage rows keep a deleted bot's id (its name stays in `bot_deletions`) and
 * outlive their runs, so every join is a LEFT JOIN. A run started by a routine since deleted, or
 * a run that is gone, cannot say whether a routine spent it: that is unknown, not "no routine".
 */
export async function readUsageCells(
  prisma: Pick<PrismaClient, "$queryRaw">,
  member: { spaceId: string; userId: string },
): Promise<UsageCell[]> {
  return prisma.$queryRaw<UsageCell[]>`
    SELECT u.provider, u.model, u."botId", b.name AS "botName", d.name AS "deletedBotName",
      ro.id AS "routineId", ro.name AS "routineName", rb.name AS "routineBotName",
      (coalesce(u."parentRunId", u."runId") IS NOT NULL AND r.id IS NULL)
        OR (r.trigger = 'routine' AND ro.id IS NULL) AS "routineUnknown",
      count(*)::int AS calls,
      count(u."inputTokens")::int AS "inputCount",
      coalesce(sum(u."inputTokens"), 0)::float8 AS "inputTokens",
      count(u."outputTokens")::int AS "outputCount",
      coalesce(sum(u."outputTokens"), 0)::float8 AS "outputTokens",
      count(u."totalTokens")::int AS "totalCount",
      coalesce(sum(u."totalTokens"), 0)::float8 AS "totalTokens",
      count(u."costUsd")::int AS "costCount",
      coalesce(sum(u."costUsd"), 0)::float8 AS "costUsd"
    FROM usage_records u
    LEFT JOIN bots b ON b.id = u."botId"
    LEFT JOIN bot_deletions d ON d.id = u."botId"
    LEFT JOIN runs r ON r.id = coalesce(u."parentRunId", u."runId")
    LEFT JOIN routines ro ON ro.id = r."routineId"
    LEFT JOIN bots rb ON rb.id = ro."botId"
    WHERE u."spaceId" = ${member.spaceId} AND u."userId" = ${member.userId}
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`;
}

/** How many days the `day` grouping reads, today included. */
export const USAGE_DAYS = 30;

/** `YYYY-MM-DD` of an instant in a time zone, whatever zone the server or database runs in. */
function dayIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * The first day shown, and an instant a safe margin before it so the query can use the table's
 * time index before the exact day test (a zone is at most a day away from UTC).
 */
export function usageDayWindow(timeZone: string, now: Date): { firstDay: string; since: Date } {
  const [year, month, day] = dayIn(timeZone, now).split("-").map(Number);
  const first = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) - (USAGE_DAYS - 1)));
  return {
    firstDay: first.toISOString().slice(0, 10),
    since: new Date(first.getTime() - 2 * 86_400_000),
  };
}

const NO_CELL: UsageCell = {
  provider: "",
  model: "",
  botId: null,
  botName: null,
  deletedBotName: null,
  routineId: null,
  routineName: null,
  routineBotName: null,
  routineUnknown: false,
  calls: 0,
  inputCount: 0,
  inputTokens: 0,
  outputCount: 0,
  outputTokens: 0,
  totalCount: 0,
  totalTokens: 0,
  costCount: 0,
  costUsd: 0,
};

/**
 * A zone both JavaScript and the database know, else UTC: a name only one of them accepts would
 * fail the whole query, and the person would see no usage at all.
 */
async function knownZone(prisma: Pick<PrismaClient, "$queryRaw">, name: string): Promise<string> {
  if (!isValidTimeZone(name)) return "UTC";
  const known = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM pg_timezone_names WHERE name = ${name}::text`;
  return known.length > 0 ? name : "UTC";
}

/**
 * The caller's records per day of `timeZone` over the last `USAGE_DAYS` days. `createdAt` is a
 * `timestamp` holding UTC, so the day is cut from `createdAt AT TIME ZONE 'UTC' AT TIME ZONE zone`
 * and reads the same whatever zone the database session runs in.
 */
export async function readDayCells(
  prisma: Pick<PrismaClient, "$queryRaw">,
  member: { spaceId: string; userId: string },
  accountZone: string,
  now = new Date(),
): Promise<UsageCell[]> {
  const timeZone = await knownZone(prisma, accountZone);
  const { firstDay, since } = usageDayWindow(timeZone, now);
  const rows = await prisma.$queryRaw<Array<Partial<UsageCell>>>`
    SELECT day, count(*)::int AS calls,
      count("inputTokens")::int AS "inputCount",
      coalesce(sum("inputTokens"), 0)::float8 AS "inputTokens",
      count("outputTokens")::int AS "outputCount",
      coalesce(sum("outputTokens"), 0)::float8 AS "outputTokens",
      count("totalTokens")::int AS "totalCount",
      coalesce(sum("totalTokens"), 0)::float8 AS "totalTokens",
      count("costUsd")::int AS "costCount",
      coalesce(sum("costUsd"), 0)::float8 AS "costUsd"
    FROM (
      SELECT to_char((u."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}::text,
        'YYYY-MM-DD') AS day, u."inputTokens", u."outputTokens", u."totalTokens", u."costUsd"
      FROM usage_records u
      WHERE u."spaceId" = ${member.spaceId} AND u."userId" = ${member.userId}
        AND u."createdAt" >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    ) days
    WHERE day >= ${firstDay}
    GROUP BY day`;
  return rows.map((row) => ({ ...NO_CELL, ...row }));
}

/**
 * Every member's records in the Space, per person. The caller must already be the Space's owner:
 * this reads other people's spend.
 */
export async function readPersonCells(
  prisma: Pick<PrismaClient, "$queryRaw">,
  spaceId: string,
): Promise<UsageCell[]> {
  const rows = await prisma.$queryRaw<Array<Partial<UsageCell>>>`
    SELECT u."userId", usr.name AS "userName", usr.email AS "userEmail",
      count(*)::int AS calls,
      count(u."inputTokens")::int AS "inputCount",
      coalesce(sum(u."inputTokens"), 0)::float8 AS "inputTokens",
      count(u."outputTokens")::int AS "outputCount",
      coalesce(sum(u."outputTokens"), 0)::float8 AS "outputTokens",
      count(u."totalTokens")::int AS "totalCount",
      coalesce(sum(u."totalTokens"), 0)::float8 AS "totalTokens",
      count(u."costUsd")::int AS "costCount",
      coalesce(sum(u."costUsd"), 0)::float8 AS "costUsd"
    FROM usage_records u
    LEFT JOIN "user" usr ON usr.id = u."userId"
    WHERE u."spaceId" = ${spaceId}
    GROUP BY 1, 2, 3`;
  return rows.map((row) => ({ ...NO_CELL, ...row }));
}

type Identity = Pick<DozoUsageGroup, "key" | "name" | "detail" | "state">;

function identity(cell: UsageCell, by: DozoUsageGrouping): Identity {
  if (by === "day") {
    return { key: cell.day ?? "", name: cell.day ?? null, detail: null, state: "live" };
  }
  if (by === "person") {
    const key = cell.userId ?? "";
    if (cell.userName == null) return { key, name: null, detail: null, state: "unknown" };
    return { key, name: cell.userName, detail: cell.userEmail ?? null, state: "live" };
  }
  if (by === "model") {
    return {
      key: JSON.stringify([cell.provider, cell.model]),
      name: cell.model,
      detail: cell.provider,
      state: "live",
    };
  }
  if (by === "bot") {
    const key = cell.botId ?? "";
    if (cell.botName != null) return { key, name: cell.botName, detail: null, state: "live" };
    if (cell.deletedBotName != null) {
      return { key, name: cell.deletedBotName, detail: null, state: "deleted" };
    }
    return { key, name: null, detail: null, state: cell.botId ? "unknown" : "none" };
  }
  if (cell.routineId) {
    return {
      key: cell.routineId,
      name: cell.routineName,
      detail: cell.routineBotName,
      state: "live",
    };
  }
  const state = cell.routineUnknown ? "unknown" : "none";
  return { key: state, name: null, detail: null, state };
}

/** Ties fall back to named groups first, so the order never depends on the database's. */
const STATE_ORDER: Record<DozoUsageGroup["state"], number> = {
  live: 0,
  deleted: 1,
  unknown: 2,
  none: 3,
};

/**
 * Sums the cells into the groups of one grouping, costliest first. As on the Usage summary, a
 * total that would skip a record without the figure reads as unknown (null).
 */
export function groupUsage(cells: UsageCell[], by: DozoUsageGrouping): DozoUsageGroup[] {
  const groups = new Map<string, { id: Identity; sums: UsageCell }>();
  for (const cell of cells) {
    const id = identity(cell, by);
    const group = groups.get(id.key);
    if (!group) {
      groups.set(id.key, { id, sums: { ...cell } });
      continue;
    }
    const sums = group.sums;
    sums.calls += cell.calls;
    sums.inputCount += cell.inputCount;
    sums.inputTokens += cell.inputTokens;
    sums.outputCount += cell.outputCount;
    sums.outputTokens += cell.outputTokens;
    sums.totalCount += cell.totalCount;
    sums.totalTokens += cell.totalTokens;
    sums.costCount += cell.costCount;
    sums.costUsd += cell.costUsd;
  }
  return [...groups.values()]
    .map(({ id, sums }) => {
      const complete = (count: number, sum: number) => (count === sums.calls ? sum : null);
      return {
        ...id,
        modelCalls: sums.calls,
        inputTokens: complete(sums.inputCount, sums.inputTokens),
        outputTokens: complete(sums.outputCount, sums.outputTokens),
        totalTokens: complete(sums.totalCount, sums.totalTokens),
        costUsd: complete(sums.costCount, sums.costUsd),
      };
    })
    .sort(
      (a, b) =>
        // Days read newest first, like a calendar; the rest costliest first.
        (by === "day" ? b.key.localeCompare(a.key) : 0) ||
        (b.costUsd ?? -1) - (a.costUsd ?? -1) ||
        b.modelCalls - a.modelCalls ||
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        a.key.localeCompare(b.key),
    );
}

/**
 * A cell as CSV: quoted when it holds a separator, quote or line break, and with a leading quote
 * mark when a spreadsheet would read it as a formula (a bot or routine name is the user's text).
 */
function csvCell(value: string | number | null): string {
  if (value == null) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const FIGURES = ["calls", "input_tokens", "output_tokens", "total_tokens", "cost_usd"];

/**
 * The groups as CSV, one row each, in the order shown. An empty name is no bot or routine, or
 * one the records cannot tell (see `state`); an empty figure is unknown.
 */
export function usageCsv(groups: DozoUsageGroup[], by: DozoUsageGrouping): string {
  const header = {
    model: ["model", "provider"],
    bot: ["bot", "state"],
    routine: ["routine", "bot", "state"],
    day: ["day"],
    person: ["person", "email", "state"],
  }[by];
  const lines = [[...header, ...FIGURES].join(",")];
  for (const group of groups) {
    const labels = {
      model: [group.name, group.detail],
      bot: [group.name, group.state],
      routine: [group.name, group.detail, group.state],
      day: [group.name],
      person: [group.name, group.detail, group.state],
    }[by];
    const figures = [
      group.modelCalls,
      group.inputTokens,
      group.outputTokens,
      group.totalTokens,
      group.costUsd,
    ];
    lines.push([...labels, ...figures].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
