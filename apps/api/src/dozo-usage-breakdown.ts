import type { DozoUsageGroup, DozoUsageGrouping } from "@rakazo/contracts";
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

type Identity = Pick<DozoUsageGroup, "key" | "name" | "detail" | "state">;

function identity(cell: UsageCell, by: DozoUsageGrouping): Identity {
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
  }[by];
  const lines = [[...header, ...FIGURES].join(",")];
  for (const group of groups) {
    const labels = {
      model: [group.name, group.detail],
      bot: [group.name, group.state],
      routine: [group.name, group.detail, group.state],
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
