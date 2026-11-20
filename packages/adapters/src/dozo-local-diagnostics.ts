import { realpathSync } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { redactBindings, redactSensitiveText } from "@rakazo/logging";
import {
  alive,
  exe,
  exists,
  LocalRefused,
  readSecrets,
  run,
  runningPostgres,
  secretsFile,
  serverVersion,
  UsageError,
} from "./dozo-local-postgres.js";

/**
 * Gathers what a person can attach to a problem report about their local server, as one
 * `.tar.gz`: versions, platform, which processes run, the folder's layout, the settings with
 * every secret value left out, and the last lines of each log. Every log line is cleaned before
 * it is written: the folder's own secret values, tokens, addresses with credentials, email
 * addresses and the fields that carry what someone wrote are removed. It ships in the server
 * bundle (entrypoint `diagnostics`). Contract: `dozo/server-bundle/README.md`, "Diagnostics".
 */

const USAGE = 64;
const FAILED = 2;
const DEFAULT_LINES = 400;
const MAX_LINES = 5000;
const TOP = "dozo-diagnostics";
/** Files of `KEY=value` lines whose values are numbers the report may show (the app's ports). */
const PLAIN_SETTINGS = ["ports"];

export type DiagnosticsIo = {
  write(line: string): void;
  serverDir: string;
  pgBin: string;
  now?: () => Date;
};

/** A run of characters as long as a token, key or session id; nothing a person reads is. */
const TOKEN_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
/** Postgres's lines that quote a statement or the values in it. */
const PG_QUOTES = /\b(DETAIL|STATEMENT|QUERY|CONTEXT|HINT):\s.*$/;

/** One log line as it may leave the computer. */
export function cleanLine(line: string, secrets: readonly string[]): string {
  let text = line;
  for (const secret of secrets) {
    text = text.split(secret).join("[secret]");
    text = text.split(encodeURIComponent(secret)).join("[secret]");
  }
  if (text.trimStart().startsWith("{")) {
    try {
      const event = JSON.parse(text) as Record<string, unknown>;
      const { message, ...rest } = event;
      const kept = redactBindings(rest);
      text = JSON.stringify(
        typeof message === "string" ? { message: redactSensitiveText(message), ...kept } : kept,
      );
    } catch {
      text = redactSensitiveText(text);
    }
  } else {
    text = redactSensitiveText(text).replace(PG_QUOTES, "$1: [removed]");
  }
  return text.replace(TOKEN_RUN, "[token]");
}

async function lastLines(file: string, count: number): Promise<string[]> {
  const text = await readFile(file, "utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-count);
}

/** One ustar entry: a 512-byte header, then the bytes padded to 512. */
function tarEntry(name: string, body: Buffer, mtime: Date): Buffer {
  const header = Buffer.alloc(512);
  const put = (text: string, offset: number, length: number) =>
    header.write(text.slice(0, length), offset, length, "utf8");
  const octal = (value: number, length: number) =>
    value
      .toString(8)
      .padStart(length - 1, "0")
      .concat("\0");
  put(name, 0, 100);
  put(octal(0o600, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(body.length, 12), 124, 12);
  put(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\u000000", 257, 8);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

export function tarGz(files: { name: string; body: string }[], mtime: Date): Buffer {
  const entries = files.map((file) => tarEntry(file.name, Buffer.from(file.body), mtime));
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

/** A folder's names, or none when the folder does not exist. */
async function namesIn(dir: string): Promise<string[]> {
  return (await exists(dir)) ? readdir(dir) : [];
}

async function postgresVersion(pgBin: string): Promise<string | null> {
  return run(path.join(pgBin, exe("postgres")), ["--version"]).then(
    (out) => out.trim(),
    () => null,
  );
}

/** Which of the server's processes run, from the pid files the app and `run.sh` write. */
async function processes(home: string) {
  const status: Record<string, { running: boolean; port?: number }> = {};
  const postgres = await runningPostgres(path.join(home, "pgdata"));
  status.postgres = postgres ? { running: true, port: postgres.port } : { running: false };
  const pids = await namesIn(path.join(home, "run"));
  for (const name of pids.filter((file) => file.endsWith(".pid")).sort()) {
    const pid = Number((await readFile(path.join(home, "run", name), "utf8")).trim());
    status[name.slice(0, -4)] = { running: alive(pid) };
  }
  return status;
}

/** The folder's top level: names, kinds and file sizes; nothing below it is read. */
async function layout(home: string) {
  const entries = await readdir(home, { withFileTypes: true });
  const listed: { name: string; kind: string; size?: number }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) listed.push({ name: entry.name, kind: "dir" });
    else if (entry.isFile()) {
      const size = (await lstat(path.join(home, entry.name))).size;
      listed.push({ name: entry.name, kind: "file", size });
    } else listed.push({ name: entry.name, kind: "other" });
  }
  return listed;
}

/** Each setting by name; a secret's value never, a port's only when it is a number. */
async function settings(home: string, secrets: Map<string, string>) {
  const summary: Record<string, Record<string, string>> = {};
  const file = await secretsFile(home);
  if (file) {
    summary[file] = Object.fromEntries(
      [...secrets].map(([key, value]) => [key, value ? "set" : "empty"]),
    );
  }
  for (const name of PLAIN_SETTINGS) {
    if (!(await exists(path.join(home, name)))) continue;
    summary[name] = Object.fromEntries(
      [...(await readSecrets(path.join(home, name)))].map(([key, value]) => [
        key,
        /^\d{1,5}$/.test(value) ? value : "set",
      ]),
    );
  }
  return summary;
}

async function collect(home: string, out: string, lineCount: number, io: DiagnosticsIo) {
  if (!(await exists(home))) {
    throw new LocalRefused("no-server", "This folder does not exist.");
  }
  const now = io.now?.() ?? new Date();
  const file = await secretsFile(home);
  const secrets = file ? await readSecrets(path.join(home, file)) : new Map<string, string>();
  // Longest first, so a secret that holds another is removed whole.
  const values = [...secrets.values()]
    .filter((value) => value.length >= 6)
    .sort((a, b) => b.length - a.length);
  const summary = {
    createdAt: now.toISOString(),
    server: (await exists(path.join(io.serverDir, "manifest.json")))
      ? await serverVersion(io.serverDir)
      : null,
    node: process.version,
    postgres: await postgresVersion(io.pgBin),
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    cpus: os.cpus().length,
    memoryMb: Math.round(os.totalmem() / 1e6),
    processes: await processes(home),
    folder: await layout(home),
    settings: await settings(home, secrets),
  };
  const files = [{ name: `${TOP}/summary.json`, body: `${JSON.stringify(summary, null, 2)}\n` }];
  const logs = await namesIn(path.join(home, "logs"));
  for (const name of logs.filter((log) => log.endsWith(".log")).sort()) {
    const lines = await lastLines(path.join(home, "logs", name), lineCount);
    const body = lines.map((line) => cleanLine(line, values)).join("\n");
    files.push({ name: `${TOP}/logs/${name}`, body: body ? `${body}\n` : "" });
  }
  await writeFile(out, tarGz(files, now), { mode: 0o600, flag: "wx" });
  io.write(JSON.stringify({ written: out, files: files.length }));
}

/** Runs the command and returns the exit code: 0 done, 2 failed, 64 usage error. */
export async function localDiagnosticsMain(argv: string[], io: DiagnosticsIo): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        home: { type: "string" },
        out: { type: "string" },
        lines: { type: "string" },
      },
    });
    const lines = Number(values.lines ?? DEFAULT_LINES);
    if (positionals.length > 0 || !values.home || !values.out) {
      throw new UsageError("usage: diagnostics --home <server folder> --out <file.tar.gz>");
    }
    if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LINES) {
      throw new UsageError(`--lines takes a whole number from 1 to ${MAX_LINES}`);
    }
    await collect(path.resolve(values.home), path.resolve(values.out), lines, io);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.write(JSON.stringify({ error: error.message, reason: "usage" }));
      return USAGE;
    }
    const reason = error instanceof LocalRefused ? error.reason : "failed";
    io.write(JSON.stringify({ error: (error as Error).message, reason }));
    return FAILED;
  }
}

/** The command as a process: arguments, environment and streams from `proc`. */
export function localDiagnosticsProcess(
  proc: Pick<NodeJS.Process, "argv" | "env" | "stdout">,
  here = import.meta.url,
): Promise<number> {
  // In the bundle this file sits in the server folder, and Postgres in `../../postgres/bin`.
  const serverDir = proc.env.DOZO_SERVER_DIR ?? path.dirname(fileURLToPath(here));
  return localDiagnosticsMain(proc.argv.slice(2), {
    write: (line) => proc.stdout.write(`${line}\n`),
    serverDir,
    pgBin: proc.env.DOZO_PG_BIN ?? path.join(serverDir, "..", "..", "postgres", "bin"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exitCode = await localDiagnosticsProcess(process);
