import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiagnosticsIo } from "./dozo-local-diagnostics.js";
import {
  cleanLine,
  localDiagnosticsMain,
  localDiagnosticsProcess,
  tarGz,
} from "./dozo-local-diagnostics.js";

// What must never leave the computer, planted where a real folder could hold it.
const OWNER_PASSWORD = "9f1c2e7a5b3d4f60owner";
const APP_PASSWORD = "p@ss/word+with=odd chars";
const AUTH_SECRET = "c0ffee11c0ffee22c0ffee33c0ffee44c0ffee55c0ffee66";
const STACK_TOKEN = "stacktoken-7d8e9f";
const SESSION_TOKEN = "Zx81Qw27Er63Ty45Ui09Op12As34Df56";
const EMAIL = "person@example.com";
const MESSAGE = "my private message about the plan";
const BEARER = "Bearer abc.def-ghi";
const API_KEY = "sk-proj-AbCdEf0123456789xyz";
const SECRETS = [
  OWNER_PASSWORD,
  APP_PASSWORD,
  encodeURIComponent(APP_PASSWORD),
  AUTH_SECRET,
  STACK_TOKEN,
  SESSION_TOKEN,
  EMAIL,
  MESSAGE,
  "abc.def-ghi",
  API_KEY,
];

let root: string;
let home: string;
let serverDir: string;
let pgBin: string;
let lines: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dozo-diag-"));
  home = path.join(root, "home");
  serverDir = path.join(root, "rakazo-server");
  pgBin = path.join(root, "postgres", "bin");
  lines = [];
  await mkdir(path.join(home, "logs"), { recursive: true });
  await mkdir(path.join(home, "run"));
  await mkdir(path.join(home, "pgdata"));
  await mkdir(serverDir);
  await mkdir(pgBin, { recursive: true });
  await writeFile(path.join(serverDir, "manifest.json"), JSON.stringify({ version: "0.11.0-3" }));
  await writeFile(path.join(pgBin, "postgres"), "#!/bin/sh\necho 'postgres (PostgreSQL) 16.16'\n");
  await chmod(path.join(pgBin, "postgres"), 0o755);
  await writeFile(
    path.join(home, "secrets"),
    [
      `PG_OWNER_PASSWORD=${OWNER_PASSWORD}`,
      `PG_APP_PASSWORD=${APP_PASSWORD}`,
      `BETTER_AUTH_SECRET=${AUTH_SECRET}`,
      `STACK_TOKEN=${STACK_TOKEN}`,
      "EMPTY=",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(path.join(home, "ports"), "postgres=54329\napi=3100\nweb=host.example\n");
  await writeFile(path.join(home, "pgdata/postmaster.pid"), `${process.pid}\n/x\n0\n54329\n`);
  await writeFile(path.join(home, "run/api.pid"), String(process.pid));
  await writeFile(path.join(home, "run/worker.pid"), "0");
  await writeFile(
    path.join(home, "logs/api.log"),
    [
      ...Array.from({ length: 30 }, (_, n) => `old line ${n}`),
      JSON.stringify({ level: "info", message: "Web listening on 127.0.0.1:5173" }),
      JSON.stringify({ level: "info", message: "run.reply", content: MESSAGE, text: MESSAGE }),
      JSON.stringify({ level: "warn", message: `sign-in for ${EMAIL}`, "user.id": "u_1" }),
      JSON.stringify({ level: "error", message: "boom", error: { message: `token ${API_KEY}` } }),
      `{"level":"info","message":"cut short ${STACK_TOKEN}`,
      `connecting postgres://rakazo_app:${encodeURIComponent(APP_PASSWORD)}@127.0.0.1:54329/rakazo`,
      `cookie better-auth.session_token=${SESSION_TOKEN}`,
      `authorization: ${BEARER}`,
      `secret is ${AUTH_SECRET} and owner ${OWNER_PASSWORD}`,
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(home, "logs/postgres.log"),
    [
      "LOG:  database system is ready to accept connections",
      `ERROR:  duplicate key value violates unique constraint "user_email_key"`,
      `DETAIL:  Key (email)=(${EMAIL}) already exists.`,
      `STATEMENT:  INSERT INTO message (text) VALUES ('${MESSAGE}')`,
    ].join("\n"),
  );
  await writeFile(path.join(home, "logs/empty.log"), "");
  await writeFile(path.join(home, "logs/not-a-log.txt"), MESSAGE);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function main(argv: string[]) {
  const io: DiagnosticsIo = {
    write: (line) => lines.push(line),
    serverDir,
    pgBin,
    now: () => new Date("2026-11-20T10:00:00Z"),
  };
  return localDiagnosticsMain(argv, io);
}

const last = () => JSON.parse(lines.at(-1) ?? "{}");

/** Unpacks with the system's tar, so the archive is one any tool reads. */
async function unpack(archive: string) {
  const into = path.join(root, "unpacked");
  await mkdir(into);
  execFileSync("tar", ["-xzf", archive, "-C", into]);
  const files: Record<string, string> = {};
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(at, `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = await readFile(at, "utf8");
    }
  };
  await walk(into, "");
  return files;
}

describe("local diagnostics", () => {
  it("writes versions, processes, settings and logs without a single secret", async () => {
    const out = path.join(root, "report.tar.gz");
    expect(await main(["--home", home, "--out", out, "--lines", "12"])).toBe(0);
    expect(last()).toEqual({ written: out, files: 4 });
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const files = await unpack(out);
    expect(Object.keys(files).sort()).toEqual([
      "dozo-diagnostics/logs/api.log",
      "dozo-diagnostics/logs/empty.log",
      "dozo-diagnostics/logs/postgres.log",
      "dozo-diagnostics/summary.json",
    ]);
    const everything = Object.values(files).join("\n");
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
    // The raw archive too, in case a name or header carried one.
    const raw = execFileSync("gzip", ["-dc", out]).toString("latin1");
    for (const secret of SECRETS) expect(raw).not.toContain(secret);

    const summary = JSON.parse(files["dozo-diagnostics/summary.json"] ?? "{}");
    expect(summary).toMatchObject({
      createdAt: "2026-11-20T10:00:00.000Z",
      server: "0.11.0-3",
      node: process.version,
      postgres: "postgres (PostgreSQL) 16.16",
      platform: process.platform,
      processes: {
        postgres: { running: true, port: 54329 },
        api: { running: true },
        worker: { running: false },
      },
      settings: {
        secrets: {
          PG_OWNER_PASSWORD: "set",
          PG_APP_PASSWORD: "set",
          BETTER_AUTH_SECRET: "set",
          STACK_TOKEN: "set",
          EMPTY: "empty",
        },
        ports: { postgres: "54329", api: "3100", web: "set" },
      },
    });
    expect(summary.folder).toContainEqual({ name: "pgdata", kind: "dir" });
    expect(summary.folder).toContainEqual(expect.objectContaining({ name: "secrets" }));

    const api = files["dozo-diagnostics/logs/api.log"] ?? "";
    expect(api.trim().split("\n")).toHaveLength(12);
    expect(api).not.toContain("old line 17");
    expect(api).toContain("Web listening on 127.0.0.1:5173");
    expect(api).toContain('"message":"run.reply"');
    const postgres = files["dozo-diagnostics/logs/postgres.log"] ?? "";
    expect(postgres).toContain("ready to accept connections");
    expect(postgres).toContain("DETAIL: [removed]");
    expect(postgres).toContain("STATEMENT: [removed]");
  });

  it("works on a folder with nothing but logs, and on a server that is not built", async () => {
    const bare = path.join(root, "bare");
    await mkdir(path.join(bare, "logs"), { recursive: true });
    await writeFile(path.join(bare, "logs/manager.log"), "started\n");
    serverDir = path.join(root, "nowhere");
    pgBin = path.join(root, "nowhere");
    const out = path.join(root, "bare.tar.gz");
    expect(await main(["--home", bare, "--out", out])).toBe(0);
    const summary = JSON.parse((await unpack(out))["dozo-diagnostics/summary.json"] ?? "{}");
    expect(summary).toMatchObject({
      server: null,
      postgres: null,
      processes: { postgres: { running: false } },
      settings: {},
    });
  });

  it("refuses a missing folder and an existing report, and a wrong call", async () => {
    const out = path.join(root, "r.tar.gz");
    expect(await main(["--home", path.join(root, "missing"), "--out", out])).toBe(2);
    expect(last()).toMatchObject({ reason: "no-server" });
    await writeFile(out, "keep me");
    expect(await main(["--home", home, "--out", out])).toBe(2);
    expect(last()).toMatchObject({ reason: "failed" });
    expect(await readFile(out, "utf8")).toBe("keep me");
    expect(await main(["--home", home])).toBe(64);
    expect(await main(["--home", home, "--out", out, "extra"])).toBe(64);
    expect(await main(["--home", home, "--out", out, "--lines", "0"])).toBe(64);
    expect(await main(["--home", home, "--out", out, "--lines", "many"])).toBe(64);
    expect(last()).toMatchObject({ reason: "usage" });
  });

  it("runs as a process from the bundle's layout", async () => {
    const written: string[] = [];
    const out = path.join(root, "p.tar.gz");
    const proc = (env: NodeJS.ProcessEnv) =>
      ({
        argv: ["node", "diagnostics", "--home", home, "--out", out],
        env,
        stdout: { write: (text: string) => written.push(text) },
      }) as unknown as NodeJS.Process;
    const here = pathToFileURL(path.join(serverDir, "dozo-diagnostics.mjs")).href;
    expect(await localDiagnosticsProcess(proc({}), here)).toBe(0);
    expect(JSON.parse(written[0] ?? "{}")).toEqual({ written: out, files: 4 });
    const env = { DOZO_SERVER_DIR: serverDir, DOZO_PG_BIN: pgBin };
    expect(await localDiagnosticsProcess(proc(env), here)).toBe(2);
  });
});

describe("log line cleaning", () => {
  it("keeps what helps and drops what identifies", () => {
    expect(cleanLine("plain words stay", [])).toBe("plain words stay");
    expect(cleanLine(`x ${"a".repeat(40)} y`, [])).toBe("x [token] y");
    expect(cleanLine(JSON.stringify({ text: MESSAGE }), [])).not.toContain(MESSAGE);
    expect(cleanLine("[1, 2]", [])).toBe("[1, 2]");
  });

  it("writes an archive whose long names are cut, not spilled", () => {
    const archive = tarGz([{ name: `${"n".repeat(120)}`, body: "x" }], new Date(0));
    expect(archive.length).toBeGreaterThan(0);
  });
});
