import { scryptSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResetIo } from "./dozo-local-reset-password.js";
import {
  hashPassword,
  localResetPasswordMain,
  localResetPasswordProcess,
} from "./dozo-local-reset-password.js";

const NEW_PASSWORD = "a new local password";
/** Made by the sign-in library's own `hashPassword` for NEW_PASSWORD. */
const LIBRARY_HASH =
  "720498ccb34f4cf8cea825ad21dc53d2:9f496874eaef41f74603b6715592c73122521b82b41ab0fc5af7e36c745c05a0a28a476af81d6271bd37ac1461a903926807f3804384a26991638b4105608e7d";

/**
 * Stand-ins for the bundle's Postgres programs: each logs its arguments; `psql` answers the
 * account query with FAKE_PG_USERS (one `id|credentials` per line) and the change with counts,
 * and keeps the change's SQL. The real reset and sign-in run in `dozo/server-bundle/smoke.sh`.
 */
const FAKE = `#!/bin/sh
name=$(basename "$0")
echo "$name $*" >> "$FAKE_PG_LOG"
last=""; for a in "$@"; do last="$a"; done
case "$name" in
  psql) case "$last" in
    SELECT\\ u.id*) printf '%b' "$FAKE_PG_USERS" ;;
    WITH*) printf '%s' "$last" > "$FAKE_PG_SQL"; echo "1|2|1|1" ;;
  esac ;;
  pg_ctl) [ "$last" = "$FAKE_PG_FAIL" ] && { echo "could not $last" >&2; exit 1; } ;;
esac
exit 0
`;

let root: string;
let home: string;
let pgBin: string;
let lines: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dozo-reset-"));
  home = path.join(root, "home");
  pgBin = path.join(root, "postgres", "bin");
  lines = [];
  await mkdir(pgBin, { recursive: true });
  for (const name of ["pg_ctl", "psql"]) {
    await writeFile(path.join(pgBin, name), FAKE);
    await chmod(path.join(pgBin, name), 0o755);
  }
  await mkdir(path.join(home, "pgdata"), { recursive: true });
  await writeFile(path.join(home, "pgdata/PG_VERSION"), "16\n");
  await writeFile(path.join(home, "secrets"), "PG_OWNER_PASSWORD=owner\n", { mode: 0o600 });
  vi.stubEnv("FAKE_PG_LOG", path.join(root, "pg.log"));
  vi.stubEnv("FAKE_PG_SQL", path.join(root, "change.sql"));
  vi.stubEnv("FAKE_PG_USERS", "user_1|1\\n");
  vi.stubEnv("FAKE_PG_FAIL", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function main(argv: string[], options: { stdin?: string; env?: NodeJS.ProcessEnv; uid?: number }) {
  const io: ResetIo = {
    write: (line) => lines.push(line),
    stdin: Readable.from(options.stdin === undefined ? [] : [options.stdin]),
    pgBin,
    env: options.env ?? {},
    uid: "uid" in options ? options.uid : process.getuid?.(),
  };
  return localResetPasswordMain(argv, io);
}

const last = () => JSON.parse(lines.at(-1) ?? "{}");
const log = async () => (await readFile(path.join(root, "pg.log"), "utf8")).trim().split("\n");

describe("password hash", () => {
  it("is the one the sign-in library makes and checks", async () => {
    const [salt = ""] = LIBRARY_HASH.split(":");
    expect(await hashPassword(NEW_PASSWORD, salt)).toBe(LIBRARY_HASH);
    const made = await hashPassword(NEW_PASSWORD);
    const [madeSalt = "", key] = made.split(":");
    expect(madeSalt).toMatch(/^[0-9a-f]{32}$/);
    const again = scryptSync(NEW_PASSWORD.normalize("NFKC"), madeSalt, 64, {
      N: 16384,
      r: 16,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    expect(key).toBe(again.toString("hex"));
  });
});

describe("local password reset", () => {
  it("sets the password, ends every session and logs it, with the server stopped", async () => {
    expect(await main(["--home", home], { stdin: `${NEW_PASSWORD}\n` })).toBe(0);
    expect(last()).toEqual({ reset: true, sessionsEnded: 2 });
    const sql = await readFile(path.join(root, "change.sql"), "utf8");
    const hash = /SET password = '([0-9a-f]{32}:[0-9a-f]{128})'/.exec(sql)?.[1] ?? "";
    const [salt = ""] = hash.split(":");
    expect(await hashPassword(NEW_PASSWORD, salt)).toBe(hash);
    expect(sql).toContain(`DELETE FROM session WHERE "userId" = 'user_1'`);
    expect(sql).toContain("INSERT INTO security_events");
    expect(sql).toContain("INSERT INTO audit_events");
    expect(sql).not.toContain(NEW_PASSWORD);
    // Postgres was started for it and stopped after.
    const calls = (await log()).filter((line) => /^(pg_ctl|psql) /.test(line));
    expect(calls.map((line) => line.split(" ")[0])).toEqual(["pg_ctl", "psql", "psql", "pg_ctl"]);
    expect(calls.at(-1)).toMatch(/ stop$/);
  });

  it("uses the running server's Postgres as it is", async () => {
    await writeFile(path.join(home, "pgdata/postmaster.pid"), `${process.pid}\n/x\n0\n54321\n`);
    expect(await main(["--home", home], { stdin: `${NEW_PASSWORD}\n` })).toBe(0);
    const calls = await log();
    expect(calls.filter((line) => line.startsWith("pg_ctl"))).toEqual([]);
    expect(calls[0]).toContain("-p 54321");
  });

  it("refuses where there is no password to reset", async () => {
    vi.stubEnv("FAKE_PG_USERS", "user_1|0\\n");
    expect(await main(["--home", home], { stdin: `${NEW_PASSWORD}\n` })).toBe(2);
    expect(last()).toMatchObject({ reason: "hosted-login" });
    const env = { HOSTED_LOGIN_ISSUER: "https://example.invalid" };
    expect(await main(["--home", home], { stdin: `${NEW_PASSWORD}\n`, env })).toBe(2);
    expect(last()).toMatchObject({ reason: "hosted-login" });

    vi.stubEnv("FAKE_PG_USERS", "");
    expect(await main(["--home", home], { stdin: `${NEW_PASSWORD}\n` })).toBe(2);
    expect(last()).toMatchObject({ reason: "no-account" });
    vi.stubEnv("FAKE_PG_USERS", "user_1|1\\nuser_2|1\\n");
    expect(await main(["--home", home], { stdin: `${NEW_PASSWORD}\n` })).toBe(2);
    expect(last()).toMatchObject({ reason: "several-accounts" });
    vi.stubEnv("FAKE_PG_USERS", "user'; DROP TABLE x;--|1\\n");
    expect(await main(["--home", home], { stdin: `${NEW_PASSWORD}\n` })).toBe(2);
    expect(last()).toMatchObject({ reason: "failed" });
  });

  it("refuses a folder without a server, or one another person owns", async () => {
    const empty = path.join(root, "empty");
    expect(await main(["--home", empty], { stdin: `${NEW_PASSWORD}\n` })).toBe(2);
    expect(last()).toMatchObject({ reason: "no-server" });
    const someoneElse = (process.getuid?.() ?? 1000) + 1;
    expect(await main(["--home", home], { stdin: `${NEW_PASSWORD}\n`, uid: someoneElse })).toBe(2);
    expect(last()).toMatchObject({ reason: "not-owner" });
    // Where the system has no user ids, reading the file is the only check.
    expect(await main(["--home", home], { stdin: `${NEW_PASSWORD}\n`, uid: undefined })).toBe(0);
  });

  it("reports a Postgres that does not start", async () => {
    vi.stubEnv("FAKE_PG_FAIL", "start");
    expect(await main(["--home", home], { stdin: `${NEW_PASSWORD}\n` })).toBe(2);
    expect(last()).toMatchObject({ reason: "failed" });
    expect(last().error).toContain("could not start");
  });

  it("answers a wrong call with its usage", async () => {
    expect(await main([], { stdin: `${NEW_PASSWORD}\n` })).toBe(64);
    expect(await main(["--home", home, "extra"], { stdin: `${NEW_PASSWORD}\n` })).toBe(64);
    expect(await main(["--home", home], { stdin: "short\n" })).toBe(64);
    expect(await main(["--home", home], { stdin: `${"x".repeat(129)}\n` })).toBe(64);
    expect(await main(["--home", home], {})).toBe(64);
    expect(last()).toMatchObject({ reason: "usage" });
  });

  it("runs as a process from the bundle's layout", async () => {
    const serverDir = path.join(root, "v", "server", "rakazo-server");
    await mkdir(serverDir, { recursive: true });
    await mkdir(path.join(root, "v", "postgres"));
    await symlink(pgBin, path.join(root, "v", "postgres", "bin"));
    const written: string[] = [];
    const proc = (env: NodeJS.ProcessEnv) =>
      ({
        argv: ["node", "reset-password", "--home", home],
        env,
        stdin: Readable.from([`${NEW_PASSWORD}\n`]),
        stdout: { write: (text: string) => written.push(text) },
      }) as unknown as NodeJS.Process;
    const here = pathToFileURL(path.join(serverDir, "dozo-reset-password.mjs")).href;
    expect(await localResetPasswordProcess(proc({}), here)).toBe(0);
    expect(JSON.parse(written[0] ?? "{}")).toEqual({ reset: true, sessionsEnded: 2 });
    const elsewhere = { DOZO_SERVER_DIR: serverDir, DOZO_PG_BIN: path.join(root, "nowhere") };
    expect(await localResetPasswordProcess(proc(elsewhere), here)).toBe(2);
  });
});
