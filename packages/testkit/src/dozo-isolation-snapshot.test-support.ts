// Snapshot of everything P and S hold, read through the system client: a row of P or S that a
// foreign caller's requests changed is a leak.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@rakazo/db";

type ModelInfo = { delegate: string; fields: Set<string> };

let models: ModelInfo[] | undefined;

/** Every model of the schema with its scalar field names, read from the schema file itself. */
function schemaModels(): ModelInfo[] {
  if (models) return models;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(path.resolve(here, "../../db/prisma/schema.prisma"), "utf8");
  models = [];
  for (const block of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const fields = new Set<string>();
    for (const line of block[2]!.split("\n")) {
      const field = /^\s+(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);
      if (field && !line.trim().startsWith("//") && !line.trim().startsWith("@@"))
        fields.add(field[1]!);
    }
    const name = block[1]!;
    models.push({ delegate: name.charAt(0).toLowerCase() + name.slice(1), fields });
  }
  return models;
}

export type Snapshot = Map<string, Map<string, string>>;

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return `${item}n`;
    if (item instanceof Uint8Array) return Buffer.from(item).toString("hex");
    if (item && typeof item === "object" && !Array.isArray(item) && !(item instanceof Date)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

/**
 * Every row any table holds for the given Spaces: rows keyed by the Space, its organization, its
 * owner (an API key by its reference), or one of its bots or chats. Rows are compared whole, so an update shows as a change.
 */
export async function snapshot(
  db: PrismaClient,
  scope: { spaceIds: string[]; organizationIds: string[]; userIds: string[] },
): Promise<Snapshot> {
  const bots = (
    await db.bot.findMany({ where: { spaceId: { in: scope.spaceIds } }, select: { id: true } })
  ).map((bot) => bot.id);
  const threads = (
    await db.thread.findMany({ where: { spaceId: { in: scope.spaceIds } }, select: { id: true } })
  ).map((thread) => thread.id);
  const keys: Record<string, string[]> = {
    spaceId: scope.spaceIds,
    organizationId: scope.organizationIds,
    userId: scope.userIds,
    // An API key names its person as its reference.
    referenceId: scope.userIds,
    botId: bots,
    threadId: threads,
  };
  const result: Snapshot = new Map();
  const client = db as unknown as Record<string, { findMany(args: unknown): Promise<unknown[]> }>;
  for (const model of schemaModels()) {
    const or: Record<string, unknown>[] = [];
    // A row that names its Space belongs where that Space is; the rest by owner, bot or chat.
    const fields = model.fields.has("spaceId") ? ["spaceId"] : Object.keys(keys);
    for (const field of fields) {
      const values = keys[field] ?? [];
      if (model.fields.has(field) && values.length) or.push({ [field]: { in: values } });
    }
    if (model.delegate === "space") or.push({ id: { in: scope.spaceIds } });
    if (model.delegate === "organization") or.push({ id: { in: scope.organizationIds } });
    if (model.delegate === "user") or.push({ id: { in: scope.userIds } });
    if (!or.length || !client[model.delegate]) continue;
    const rows = (await client[model.delegate]!.findMany({ where: { OR: or } })) as Record<
      string,
      unknown
    >[];
    const byKey = new Map<string, string>();
    for (const row of rows) {
      const text = stable(row);
      byKey.set(typeof row.id === "string" ? row.id : text, text);
    }
    result.set(model.delegate, byKey);
  }
  await rawTables(db, keys, result);
  return result;
}

let mappedTables: Set<string> | undefined;

/**
 * Tables the fork makes with plain SQL, which the schema file does not list (access tokens,
 * command rules, pins, ...): their rows by the same keys, read through information_schema. Also
 * the job queue's own table when the database has one, by any job whose payload names a key.
 */
async function rawTables(db: PrismaClient, keys: Record<string, string[]>, result: Snapshot) {
  if (!mappedTables) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(path.resolve(here, "../../db/prisma/schema.prisma"), "utf8");
    mappedTables = new Set(
      [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(
        (block) => /@@map\("([^"]+)"\)/.exec(block[2]!)?.[1] ?? block[1]!,
      ),
    );
  }
  const columns = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('spaceId', 'userId', 'botId', 'threadId', 'organizationId', 'id')`;
  const byTable = new Map<string, Set<string>>();
  for (const row of columns) {
    if (mappedTables.has(row.table_name) || row.table_name.startsWith("_")) continue;
    const set = byTable.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    byTable.set(row.table_name, set);
  }
  for (const [table, present] of byTable) {
    const fields = present.has("spaceId") ? ["spaceId"] : Object.keys(keys);
    const where: string[] = [];
    const values: string[][] = [];
    for (const field of fields) {
      if (!present.has(field) || !keys[field]?.length) continue;
      values.push(keys[field]!);
      where.push(`"${field}" = ANY($${values.length}::text[])`);
    }
    if (!where.length) continue;
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "${table}" WHERE ${where.join(" OR ")}`,
      ...values,
    );
    const byKey = new Map<string, string>();
    for (const row of rows) {
      const text = stable(row);
      byKey.set(typeof row.id === "string" ? row.id : text, text);
    }
    result.set(`sql:${table}`, byKey);
  }
  const all = Object.values(keys).flat();
  for (const queue of ["graphile_worker._private_jobs", "graphile_worker.jobs"]) {
    const [found] = await db.$queryRawUnsafe<{ name: string | null }[]>(
      "SELECT to_regclass($1)::text AS name",
      queue,
    );
    if (!found?.name) continue;
    const jobs = await db.$queryRawUnsafe<{ id: unknown; text: string }[]>(
      `SELECT id, row_to_json(j)::text AS text FROM ${queue} j`,
    );
    const byKey = new Map<string, string>();
    for (const job of jobs)
      if (all.some((value) => job.text.includes(value))) byKey.set(String(job.id), job.text);
    result.set(`queue:${queue}`, byKey);
    break;
  }
}

/** Each table whose rows differ, with what was added, removed or changed. */
export function snapshotDiff(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = [];
  for (const [table, rows] of after) {
    const old = before.get(table) ?? new Map<string, string>();
    const added = [...rows.keys()].filter((key) => !old.has(key));
    const removed = [...old.keys()].filter((key) => !rows.has(key));
    const changed = [...rows.keys()].filter(
      (key) => old.has(key) && old.get(key) !== rows.get(key),
    );
    if (added.length || removed.length || changed.length) {
      const sample = changed[0]
        ? ` e.g. ${old.get(changed[0])} -> ${rows.get(changed[0])}`.slice(0, 600)
        : "";
      const addedSample = added[0] ? ` added e.g. ${rows.get(added[0])}`.slice(0, 600) : "";
      changes.push(
        `${table}: +${added.length} -${removed.length} ~${changed.length}${sample}${addedSample}`,
      );
    }
  }
  return changes;
}
