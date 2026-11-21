import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

const DAY = 24 * 60 * 60 * 1000;
/** Days of counters `stats` returns; older ones are deleted. */
const KEPT_DAYS = 14;

export type RegistryLimits = {
  /** Channels that may exist at once; 0 is no ceiling. */
  maxChannels: number;
  /** Unpaired channels one source may hold at once; 0 is no limit. */
  pendingPerSource: number;
  /** Live channels one source may have registered in the last day; 0 is no limit. */
  channelsPerSourceDaily: number;
};

export type Reservation = "reserved" | "refused";

/** Counters for one UTC day. They count events, never who caused them. */
export type DayCounters = {
  day: string;
  registered: number;
  paired: number;
  evicted: number;
  refusedPending: number;
  refusedDaily: number;
  refusedCeiling: number;
};

export type RegistryStats = { channels: number; pending: number; days: DayCounters[] };

type Refusal = "refused_pending" | "refused_daily" | "refused_ceiling";

/**
 * One object for the whole relay. It counts live channels against `MAX_CHANNELS`, holds the
 * per-source limits on registration, and keeps daily counters. It is asked when a channel is
 * registered, paired or deleted, so it writes nothing on connects or messages.
 *
 * A source is the registering address (IPv4) or its /64 (IPv6), kept only as a keyed hash whose
 * key never leaves this object, and only for a day after registration. When the ceiling is
 * reached, the oldest unpaired channel makes room; a paired channel is never pushed out. Release
 * is idempotent: a channel deleted twice is counted once.
 */
export class Registry extends DurableObject<Env> {
  private key: Promise<CryptoKey> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const { sql } = ctx.storage;
    sql.exec("CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS total (one INTEGER PRIMARY KEY CHECK (one = 1), count INTEGER NOT NULL)",
    );
    sql.exec("INSERT OR IGNORE INTO total (one, count) VALUES (1, 0)");
    // Added after the first release: rows from before have no source and count as paired.
    addColumn(sql, "channels", "source", "TEXT");
    addColumn(sql, "channels", "pending", "INTEGER NOT NULL DEFAULT 0");
    addColumn(sql, "channels", "created_at", "INTEGER NOT NULL DEFAULT 0");
    addColumn(sql, "total", "pending", "INTEGER NOT NULL DEFAULT 0");
    sql.exec("CREATE INDEX IF NOT EXISTS channels_source ON channels (source, pending)");
    sql.exec(
      "CREATE INDEX IF NOT EXISTS channels_pending ON channels (created_at) WHERE pending = 1",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS channels_sourced ON channels (created_at) WHERE source IS NOT NULL",
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, registered INTEGER NOT NULL DEFAULT 0,
        paired INTEGER NOT NULL DEFAULT 0, evicted INTEGER NOT NULL DEFAULT 0,
        refused_pending INTEGER NOT NULL DEFAULT 0, refused_daily INTEGER NOT NULL DEFAULT 0,
        refused_ceiling INTEGER NOT NULL DEFAULT 0)`,
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS secret (one INTEGER PRIMARY KEY CHECK (one = 1), key BLOB)",
    );
  }

  /**
   * Counts a new unpaired channel in, or refuses it: its source holds too many unpaired channels
   * or registered too many today, or the ceiling is reached and no unpaired channel can go.
   */
  async reserve(
    id: string,
    address: string,
    limits: RegistryLimits,
    now = Date.now(),
  ): Promise<Reservation> {
    const source = await this.sourceTag(address);
    const { sql } = this.ctx.storage;
    return this.ctx.storage.transactionSync(() => {
      sql.exec(
        "UPDATE channels SET source = NULL WHERE source IS NOT NULL AND created_at < ?",
        now - DAY,
      );
      const refuse = (column: Refusal) => {
        this.bump(column, now);
        return "refused" as const;
      };
      const held = sql
        .exec<{ all: number; pending: number }>(
          'SELECT COUNT(*) AS "all", COALESCE(SUM(pending), 0) AS pending FROM channels WHERE source = ?',
          source,
        )
        .one();
      if (limits.pendingPerSource > 0 && held.pending >= limits.pendingPerSource) {
        return refuse("refused_pending");
      }
      if (limits.channelsPerSourceDaily > 0 && held.all >= limits.channelsPerSourceDaily) {
        return refuse("refused_daily");
      }
      if (limits.maxChannels > 0 && this.count() >= limits.maxChannels) {
        const oldest = sql
          .exec<{ id: string }>(
            "SELECT id FROM channels WHERE pending = 1 ORDER BY created_at LIMIT 1",
          )
          .toArray()[0];
        if (!oldest) return refuse("refused_ceiling");
        // Its object stays until its own alarm, but it can no longer be paired.
        this.forget(oldest.id);
        this.bump("evicted", now);
      }
      sql.exec(
        "INSERT INTO channels (id, source, pending, created_at) VALUES (?, ?, 1, ?)",
        id,
        source,
        now,
      );
      sql.exec("UPDATE total SET count = count + 1, pending = pending + 1");
      this.bump("registered", now);
      return "reserved" as const;
    });
  }

  /** Marks the channel paired; false when it is not counted any more (pushed out or deleted). */
  paired(id: string, now = Date.now()): boolean {
    const { sql } = this.ctx.storage;
    return this.ctx.storage.transactionSync(() => {
      const row = sql
        .exec<{ pending: number }>("SELECT pending FROM channels WHERE id = ?", id)
        .toArray()[0];
      if (!row) return false;
      if (row.pending === 1) {
        sql.exec("UPDATE channels SET pending = 0 WHERE id = ?", id);
        sql.exec("UPDATE total SET pending = pending - 1");
        this.bump("paired", now);
      }
      return true;
    });
  }

  release(id: string): void {
    this.ctx.storage.transactionSync(() => this.forget(id));
  }

  count(): number {
    return this.ctx.storage.sql.exec<{ count: number }>("SELECT count FROM total").one().count;
  }

  /** What the operator reads: how many channels exist and what happened each day. */
  stats(now = Date.now()): RegistryStats {
    const { sql } = this.ctx.storage;
    sql.exec("DELETE FROM daily WHERE day < ?", utcDay(now - KEPT_DAYS * DAY));
    const total = sql
      .exec<{ count: number; pending: number }>("SELECT count, pending FROM total")
      .one();
    const days = sql
      .exec<{
        day: string;
        registered: number;
        paired: number;
        evicted: number;
        refused_pending: number;
        refused_daily: number;
        refused_ceiling: number;
      }>("SELECT * FROM daily ORDER BY day DESC")
      .toArray()
      .map((row) => ({
        day: row.day,
        registered: row.registered,
        paired: row.paired,
        evicted: row.evicted,
        refusedPending: row.refused_pending,
        refusedDaily: row.refused_daily,
        refusedCeiling: row.refused_ceiling,
      }));
    return { channels: total.count, pending: total.pending, days };
  }

  private forget(id: string) {
    const { sql } = this.ctx.storage;
    const row = sql
      .exec<{ pending: number }>("DELETE FROM channels WHERE id = ? RETURNING pending", id)
      .toArray()[0];
    if (!row) return;
    sql.exec("UPDATE total SET count = count - 1, pending = pending - ?", row.pending);
  }

  private bump(column: Refusal | "registered" | "paired" | "evicted", now: number) {
    this.ctx.storage.sql.exec(
      `INSERT INTO daily (day, ${column}) VALUES (?, 1)
        ON CONFLICT (day) DO UPDATE SET ${column} = ${column} + 1`,
      utcDay(now),
    );
  }

  /** The source's keyed hash: the same source maps to the same tag, which reveals nothing else. */
  private async sourceTag(address: string) {
    this.key ??= this.loadKey();
    const mac = await crypto.subtle.sign(
      "HMAC",
      await this.key,
      new TextEncoder().encode(sourceOf(address)),
    );
    return [...new Uint8Array(mac, 0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async loadKey() {
    const { sql } = this.ctx.storage;
    let raw = sql.exec<{ key: ArrayBuffer }>("SELECT key FROM secret").toArray()[0]?.key;
    if (!raw) {
      raw = crypto.getRandomValues(new Uint8Array(32)).buffer;
      sql.exec("INSERT OR IGNORE INTO secret (one, key) VALUES (1, ?)", raw);
      raw = sql.exec<{ key: ArrayBuffer }>("SELECT key FROM secret").one().key;
    }
    return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
}

export function registry(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

/**
 * Who registered, as coarse as one customer's connection: an IPv4 address, or the /64 of an IPv6
 * address (one household or server usually has a whole /64). Anything else is taken as it is.
 */
export function sourceOf(address: string) {
  const value = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return mapped[1] as string;
  if (!value.includes(":")) return value;
  const [head = "", tail] = value.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 1) return value;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (!groups.slice(0, 4).every((group) => /^[0-9a-f]{1,4}$/.test(group))) return value;
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

function utcDay(time: number) {
  return new Date(time).toISOString().slice(0, 10);
}

function addColumn(sql: SqlStorage, table: string, column: string, type: string) {
  const columns = sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
  if (columns.some((row) => row.name === column)) return;
  sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
