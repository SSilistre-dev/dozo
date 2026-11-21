#!/usr/bin/env node
// Holds an upstream sync until someone has read every upstream migration that changes what owns a
// thread. A bot's extra chats (20270113120000_dozo_bot_chats) are threads with no owner column set:
// the fork relaxed upstream's threads_owner_chk to "at most one owner" and checks the rest with the
// dozo_threads_owner triggers, which name today's owner columns. Fork migrations carry 2027 dates
// and upstream's 2026 ones, so a new upstream migration always runs BEFORE the fork's: one that
// redefines the check, or adds, drops or renames a column of "threads", can fail on live extra
// chats (a VALIDATE) or leave a new owner column the triggers do not count. A database test only
// sees the final state, so this reads the files.
// Usage: node dozo/db/threads-owner-guard.mjs [--root DIR]. Exit 0 ok, 2 an unreviewed migration,
// 64 usage. Reviewed names: dozo/db/threads-owner-reviewed.txt (one per line, # comments).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS = "packages/db/prisma/migrations";
export const REVIEWED = "dozo/db/threads-owner-reviewed.txt";

/** True when the SQL touches what owns a thread: the owner check, or the columns of "threads". */
export function touchesThreadOwners(sql) {
  if (/threads_owner_chk/i.test(sql)) return true;
  return sql
    .split(";")
    .some((statement) =>
      /ALTER\s+TABLE\s+(ONLY\s+)?("?public"?\.)?"?threads"?\s[\s\S]*\b(ADD|DROP|RENAME)\s+COLUMN\b/i.test(
        statement,
      ),
    );
}

export function reviewedNames(text) {
  return new Set(
    text
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean),
  );
}

/** Upstream migrations (no `_dozo_` in the name) that touch thread owners and are not reviewed. */
export function unreviewed(root) {
  const reviewed = reviewedNames(readFileSync(join(root, REVIEWED), "utf8"));
  const dir = join(root, MIGRATIONS);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.includes("_dozo_"))
    .map((entry) => entry.name)
    .filter((name) => !reviewed.has(name))
    .filter((name) => touchesThreadOwners(readFileSync(join(dir, name, "migration.sql"), "utf8")))
    .sort();
}

export function main(argv, out = console) {
  let root = ".";
  if (argv.length === 2 && argv[0] === "--root") root = argv[1];
  else if (argv.length > 0) {
    out.error("usage: threads-owner-guard.mjs [--root DIR]");
    return 64;
  }
  const found = unreviewed(root);
  if (found.length === 0) {
    out.log("threads owner guard ok: no unreviewed upstream migration changes what owns a thread");
    return 0;
  }
  out.error(
    [
      "threads owner guard FAILED: these upstream migrations change threads_owner_chk or the columns of",
      "\"threads\", and run before the fork's migrations, so they can break a bot's extra chats:",
      ...found.map((name) => `  ${MIGRATIONS}/${name}`),
      'Read each one (dozo/SYNC.md, "Threads owner guard"). If it restores "exactly one owner" or',
      "validates the check, do not merge the sync until a fork migration keeps the relaxed check; if it",
      "adds an owner column, add a fork migration that counts it in the fork's thread owner triggers.",
      `Then add its name to ${REVIEWED}.`,
    ].join("\n"),
  );
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
