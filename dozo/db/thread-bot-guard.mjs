#!/usr/bin/env node
// Holds an upstream sync until someone has read every new upstream line that reads a chat's bot
// from the thread (`thread.botId`, `t."botId"`). A bot's extra chat is a thread with no botId: its
// bot is in dozo_bot_chats, and anchored rules give it to each place upstream reads a chat's bot
// for a turn, a summary, memory, search or a notice (dozo/brand/brand.json, "bot chats:"). A new
// such place would treat an extra chat as having no bot until a rule covers it, and no test would
// notice, so this reads the files.
// Usage: node dozo/db/thread-bot-guard.mjs [--root DIR] [--write]. Exit 0 ok, 2 an unreviewed line,
// 64 usage. --write rewrites the reviewed list from the tree (after reading every new line).
// Reviewed lines: dozo/db/thread-bot-reviewed.tsv (file<TAB>trimmed line, one per occurrence).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEWED = "dozo/db/thread-bot-reviewed.tsv";
const ROOTS = ["apps", "packages"];
const READS = /\bthreads?\??\.botId\b|\bt\."botId"/;

/** Upstream source files: not the fork's own, not tests, not generated or installed code. */
function sources(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "generated", "dist", "e2e", "testkit", ".turbo"].includes(entry.name))
          continue;
        walk(path);
      } else if (
        /\.(ts|tsx|mts)$/.test(entry.name) &&
        !entry.name.startsWith("dozo-") &&
        !/\.(test|spec)\.tsx?$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        found.push(path);
      }
    }
  };
  for (const top of ROOTS) walk(join(root, top));
  return found.sort();
}

/** Every line in upstream's source that reads a chat's bot from its thread, as `file\tline`. */
export function threadBotReads(root) {
  const reads = [];
  for (const path of sources(root)) {
    const file = relative(root, path);
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (READS.test(line)) reads.push(`${file}\t${line.trim()}`);
    }
  }
  return reads;
}

/** Lines in the tree beyond the reviewed ones, counting repeats of the same line. */
export function unreviewed(root, reviewedText) {
  const left = new Map();
  for (const entry of reviewedText.split("\n").filter((line) => line && !line.startsWith("#")))
    left.set(entry, (left.get(entry) ?? 0) + 1);
  const extra = [];
  for (const read of threadBotReads(root)) {
    const count = left.get(read) ?? 0;
    if (count > 0) left.set(read, count - 1);
    else extra.push(read);
  }
  return extra;
}

const HEADER = [
  "# Upstream lines that read a chat's bot from its thread, each read against a bot's extra chats",
  "# (dozo/db/thread-bot-guard.mjs). Rewrite with --write only after reading every new line.",
];

export function main(argv, out = console) {
  let root = ".";
  let write = false;
  for (const arg of argv) {
    if (arg === "--write") write = true;
    else if (arg.startsWith("--root=")) root = arg.slice("--root=".length);
    else {
      out.error("usage: thread-bot-guard.mjs [--root=DIR] [--write]");
      return 64;
    }
  }
  if (write) {
    writeFileSync(join(root, REVIEWED), `${[...HEADER, ...threadBotReads(root)].join("\n")}\n`);
    out.log(`thread bot guard: wrote ${REVIEWED}`);
    return 0;
  }
  const found = unreviewed(root, readFileSync(join(root, REVIEWED), "utf8"));
  if (found.length === 0) {
    out.log("thread bot guard ok: no unreviewed upstream line reads a chat's bot from its thread");
    return 0;
  }
  out.error(
    [
      "thread bot guard FAILED: these upstream lines read a chat's bot from its thread (botId), which",
      "is empty for a bot's extra chat:",
      ...found.map((line) => `  ${line.replace("\t", ": ")}`),
      'Read each one (dozo/SYNC.md, "Thread bot guard"): where it decides something about the chat',
      "a run, a summary, memory, search or a notice is in, add an anchored rule that reads the extra",
      "chat's bot (withDozoChatBot, DOZO_CHAT_BOT); then run this with --write.",
    ].join("\n"),
  );
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
