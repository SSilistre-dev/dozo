import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localAccountMain, localAccountProcess } from "./dozo-local-account.js";

/**
 * Stand-ins for the bundle's Postgres programs, as the backup tests use: each logs its arguments,
 * `psql` answers what the unlink statement returns. The statement itself was run against a real
 * Postgres 16 while it was written; the bundle's smoke test runs the commands end to end.
 */
const FAKE = `#!/bin/sh
name=$(basename "$0")
printf '%s\\n' "$name $*" >> "$FAKE_PG_LOG"
case "$name" in
  psql) [ -n "$FAKE_PSQL_FAIL" ] && { echo "$FAKE_PSQL_FAIL" >&2; exit 1; }; echo "$FAKE_PSQL_OUT" ;;
esac
exit 0
`;

let root: string;
let home: string;
let pgBin: string;
let lines: string[];

const io = () => ({ write: (line: string) => lines.push(line), pgBin });
const answer = () => JSON.parse(lines.at(-1) ?? "null") as Record<string, unknown>;
const log = async () => readFile(path.join(root, "pg.log"), "utf8").catch(() => "");

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dozo-account-cli-"));
  lines = [];
  home = path.join(root, "home");
  pgBin = path.join(root, "postgres", "bin");
  await mkdir(pgBin, { recursive: true });
  for (const name of ["pg_ctl", "psql"]) {
    await writeFile(path.join(pgBin, name), FAKE);
    await chmod(path.join(pgBin, name), 0o755);
  }
  await mkdir(path.join(home, "pgdata"), { recursive: true });
  await writeFile(path.join(home, "pgdata", "PG_VERSION"), "16\n");
  await writeFile(path.join(home, "secrets"), "PG_OWNER_PASSWORD=owner-secret\n");
  vi.stubEnv("FAKE_PG_LOG", path.join(root, "pg.log"));
  vi.stubEnv("FAKE_PSQL_OUT", "1 2 1");
  vi.stubEnv("FAKE_PSQL_FAIL", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("account unlink-hosted", () => {
  it("removes the hosted links and their sessions in the folder's database, and says how many", async () => {
    expect(await localAccountMain(["unlink-hosted", "--home", home], io())).toBe(0);
    expect(answer()).toEqual({ unlinked: 1, sessionsEnded: 2 });
    const calls = await log();
    expect(calls).toMatch(/^pg_ctl -D .*pgdata -w -t 60 .* start$/m);
    // The statement spans lines, so the log is read whole.
    expect(calls).toContain("psql -h 127.0.0.1 -p ");
    expect(calls).toContain("-U rakazo -d rakazo -v ON_ERROR_STOP=1 -Atc");
    expect(calls).toContain(`DELETE FROM "account" WHERE "providerId" = 'dozo-hosted'`);
    expect(calls).toContain(`DELETE FROM "session" WHERE "userId" IN (SELECT "userId" FROM gone)`);
    // Each unlinked user is marked for the next hosted sign-in to link.
    expect(calls).toContain(`INSERT INTO "verification"`);
    expect(calls).toContain(`'dozo-hosted-adopt:user:' || "userId"`);
    expect(calls).toMatch(/^pg_ctl -D .*pgdata -m fast -w stop$/m);
  });

  it("uses the Postgres that is running when the app is open", async () => {
    await writeFile(
      path.join(home, "pgdata", "postmaster.pid"),
      `${process.pid}\n${home}/pgdata\n0\n55432\n`,
    );
    expect(await localAccountMain(["unlink-hosted", "--home", home], io())).toBe(0);
    const calls = await log();
    expect(calls).not.toContain("pg_ctl");
    expect(calls).toContain("-p 55432");
  });

  it("says when there is nothing linked", async () => {
    vi.stubEnv("FAKE_PSQL_OUT", "0 0 0");
    expect(await localAccountMain(["unlink-hosted", "--home", home], io())).toBe(0);
    expect(answer()).toEqual({ unlinked: 0, sessionsEnded: 0 });
  });

  it.each([
    [[]],
    [["unlink-hosted"]],
    [["reset", "--home", "x"]],
    [["unlink-hosted", "extra", "--home", "x"]],
    [["unlink-hosted", "--nope"]],
  ])("answers %j with its usage", async (argv) => {
    expect(await localAccountMain(argv, io())).toBe(64);
    expect(answer()).toMatchObject({ reason: "usage" });
  });

  it("refuses a folder with no server", async () => {
    expect(await localAccountMain(["unlink-hosted", "--home", root], io())).toBe(2);
    expect(answer()).toMatchObject({ reason: "no-server" });
  });

  it("fails when Postgres refuses the statement", async () => {
    vi.stubEnv("FAKE_PSQL_FAIL", "relation does not exist");
    expect(await localAccountMain(["unlink-hosted", "--home", home], io())).toBe(2);
    expect(answer()).toMatchObject({ reason: "failed" });
  });

  it("runs as a process with the bundle's Postgres beside it", async () => {
    const written: string[] = [];
    const code = await localAccountProcess(
      {
        argv: ["node", "dozo-local-account.mjs", "unlink-hosted", "--home", home],
        env: { DOZO_PG_BIN: pgBin },
        stdout: { write: (line: string) => written.push(line) } as never,
      },
      "file:///opt/dozo/rakazo-server/dozo-local-account.mjs",
    );
    expect(code).toBe(0);
    expect(written).toEqual([`${JSON.stringify({ unlinked: 1, sessionsEnded: 2 })}\n`]);
    const silent: string[] = [];
    await localAccountProcess(
      { argv: ["node", "x"], env: {}, stdout: { write: (l: string) => silent.push(l) } as never },
      "file:///opt/dozo/rakazo-server/dozo-local-account.mjs",
    );
    expect(silent[0]).toContain('"reason":"usage"');
  });
});
