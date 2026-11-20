import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

/**
 * One object for the whole relay: counts live channels against `MAX_CHANNELS`. It is asked only
 * when a channel is registered or deleted, so it writes nothing on connects or messages. Release
 * is idempotent: a channel deleted twice is counted once.
 */
export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY)");
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS total (one INTEGER PRIMARY KEY CHECK (one = 1), count INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec("INSERT OR IGNORE INTO total (one, count) VALUES (1, 0)");
  }

  /** Counts the channel in, or answers false when the ceiling is reached. */
  reserve(id: string, ceiling: number): boolean {
    const { sql } = this.ctx.storage;
    return this.ctx.storage.transactionSync(() => {
      if (ceiling > 0 && this.count() >= ceiling) return false;
      if (sql.exec("INSERT OR IGNORE INTO channels (id) VALUES (?)", id).rowsWritten > 0) {
        sql.exec("UPDATE total SET count = count + 1");
      }
      return true;
    });
  }

  release(id: string): void {
    const { sql } = this.ctx.storage;
    this.ctx.storage.transactionSync(() => {
      if (sql.exec("DELETE FROM channels WHERE id = ?", id).rowsWritten > 0) {
        sql.exec("UPDATE total SET count = count - 1");
      }
    });
  }

  count(): number {
    return this.ctx.storage.sql.exec<{ count: number }>("SELECT count FROM total").one().count;
  }
}

export function registry(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}
