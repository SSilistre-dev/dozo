import { createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupIo } from "./dozo-local-backup.js";
import { localBackupMain, localBackupProcess } from "./dozo-local-backup.js";
import { writeBackup } from "./dozo-local-backup-format.js";

const PASSWORD = "a long enough password";
const KDF = { logN: 15, r: 8, p: 1 };

/**
 * Stand-ins for the bundle's Postgres programs: each logs its arguments, `initdb` makes a data
 * folder, `pg_dump` writes the database's one row into the dump and `pg_restore` puts it back,
 * `psql` lists the applied migrations. The real round trip runs in `dozo/server-bundle/smoke.sh`.
 */
const FAKE = `#!/bin/sh
name=$(basename "$0")
echo "$name $*" >> "$FAKE_PG_LOG"
last=""; for a in "$@"; do last="$a"; done
case "$name" in
  initdb) for a in "$@"; do [ "$prev" = -D ] && mkdir -p "$a" && echo 16 > "$a/PG_VERSION"; prev="$a"; done ;;
  pg_dump) for a in "$@"; do [ "$prev" = -f ] && cp "$FAKE_PG_DB" "$a"; prev="$a"; done ;;
  pg_restore) cp "$last" "$FAKE_PG_DB.restored" ;;
  psql) case "$*" in *_prisma_migrations*) printf '%s\\n' $FAKE_PG_MIGRATIONS ;; esac ;;
  pg_ctl) [ "$last" = "$FAKE_PG_FAIL" ] && { echo "could not $last" >&2; exit 1; } ;;
esac
exit 0
`;

let root: string;
let lines: string[];
let serverDir: string;
let pgBin: string;

async function server(migrations: string[]) {
  await rm(path.join(serverDir, "packages"), { recursive: true, force: true });
  for (const name of migrations) {
    await mkdir(path.join(serverDir, "packages/db/prisma/migrations", name), { recursive: true });
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dozo-backup-cli-"));
  lines = [];
  serverDir = path.join(root, "rakazo-server");
  pgBin = path.join(root, "postgres", "bin");
  await mkdir(pgBin, { recursive: true });
  for (const name of ["initdb", "pg_ctl", "pg_dump", "pg_restore", "psql", "createdb"]) {
    await writeFile(path.join(pgBin, name), FAKE);
    await chmod(path.join(pgBin, name), 0o755);
  }
  await mkdir(serverDir);
  await writeFile(path.join(serverDir, "manifest.json"), JSON.stringify({ version: "0.11.0-1" }));
  await server(["20260101000000_a", "20260201000000_b"]);
  await writeFile(path.join(root, "db"), "the database");
  vi.stubEnv("FAKE_PG_LOG", path.join(root, "pg.log"));
  vi.stubEnv("FAKE_PG_DB", path.join(root, "db"));
  vi.stubEnv("FAKE_PG_MIGRATIONS", "20260101000000_a 20260201000000_b");
  vi.stubEnv("FAKE_PG_FAIL", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function main(argv: string[], password = PASSWORD) {
  const io: BackupIo = {
    write: (line) => lines.push(line),
    stdin: Readable.from([`${password}\n`]),
    serverDir,
    pgBin,
    kdf: KDF,
  };
  return localBackupMain(argv, io);
}

const last = () => JSON.parse(lines.at(-1) ?? "{}");
const log = async () => (await readFile(path.join(root, "pg.log"), "utf8")).trim().split("\n");

/** A folder as the app leaves it after some use. */
async function usedHome(home: string, { running = false } = {}) {
  await mkdir(path.join(home, "pgdata"), { recursive: true });
  await writeFile(path.join(home, "pgdata/PG_VERSION"), "16\n");
  if (running) {
    await writeFile(path.join(home, "pgdata/postmaster.pid"), `${process.pid}\n/x\n0\n54321\n`);
  }
  await mkdir(path.join(home, "data/uploads"), { recursive: true });
  await writeFile(path.join(home, "data/uploads/photo.jpg"), "jpeg bytes");
  await mkdir(path.join(home, "relay"));
  await writeFile(path.join(home, "relay/keys.json"), "{}");
  await writeFile(path.join(home, "secrets"), "PG_OWNER_PASSWORD=owner\nENCRYPTION_KEY=key\n", {
    mode: 0o600,
  });
  await writeFile(path.join(home, "ports"), "postgres=1\napi=2\nweb=3\n");
}

describe("local backup command", () => {
  it("backs up a running server and restores it into a new installation", async () => {
    const home = path.join(root, "home");
    await usedHome(home, { running: true });
    const file = path.join(root, "my.dozo");
    expect(await main(["create", file, "--home", home])).toBe(0);
    expect(last()).toEqual({ created: file, server: "0.11.0-1" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // The app's Postgres was used as it runs, never started or stopped here.
    expect((await log()).filter((line) => line.startsWith("pg_ctl"))).toEqual([]);
    expect((await log()).find((line) => line.startsWith("pg_dump"))).toContain("-p 54321");
    expect((await readdir(home)).sort()).toEqual(["data", "pgdata", "ports", "relay", "secrets"]);

    // The new computer's app has already made its own secrets and relay keys.
    const fresh = path.join(root, "fresh");
    await mkdir(path.join(fresh, "data"), { recursive: true });
    await mkdir(path.join(fresh, "relay"));
    await writeFile(path.join(fresh, "relay/keys.json"), "new");
    await writeFile(path.join(fresh, "secrets"), "PG_OWNER_PASSWORD=other\n");
    await writeFile(path.join(root, "pg.log"), "");
    expect(await main(["restore", file, "--home", fresh])).toBe(0);
    expect(last()).toEqual({ restored: file, server: "0.11.0-1", migrate: false });
    expect(await readFile(path.join(fresh, "secrets"), "utf8")).toContain("ENCRYPTION_KEY=key");
    expect(await readFile(path.join(fresh, "data/uploads/photo.jpg"), "utf8")).toBe("jpeg bytes");
    expect(await readFile(path.join(fresh, "relay/keys.json"), "utf8")).toBe("{}");
    expect(await readFile(path.join(fresh, "pgdata/PG_VERSION"), "utf8")).toBe("16\n");
    expect(await readFile(path.join(root, "db.restored"), "utf8")).toBe("the database");
    expect((await readdir(fresh)).sort()).toEqual(["data", "pgdata", "relay", "secrets"]);
    const calls = (await log()).map((line) => line.split(" ")[0]);
    expect(calls).toEqual(["initdb", "pg_ctl", "createdb", "psql", "pg_restore", "pg_ctl"]);
    expect((await log())[0]).not.toContain("owner");
  });

  it("starts Postgres for a closed app and stops it after", async () => {
    const home = path.join(root, "home");
    await usedHome(home);
    await rm(path.join(home, "relay"), { recursive: true });
    expect(await main(["create", path.join(root, "b.dozo"), "--home", home])).toBe(0);
    const calls = (await log()).map((line) => line.split(" ").at(-1));
    expect(calls[0]).toBe("start");
    expect(calls.at(-1)).toBe("stop");
    expect((await readdir(home)).sort()).toEqual(["data", "pgdata", "ports", "secrets"]);
  });

  it("runs the migrations after restoring an older backup and refuses a newer one", async () => {
    const home = path.join(root, "home");
    await usedHome(home, { running: true });
    vi.stubEnv("FAKE_PG_MIGRATIONS", "20260101000000_a");
    const older = path.join(root, "older.dozo");
    expect(await main(["create", older, "--home", home])).toBe(0);
    expect(await main(["restore", older, "--home", path.join(root, "a")])).toBe(0);
    expect(last()).toMatchObject({ migrate: true });

    vi.stubEnv("FAKE_PG_MIGRATIONS", "20260101000000_a 20260201000000_b 20270101000000_c");
    const newer = path.join(root, "newer.dozo");
    expect(await main(["create", newer, "--home", home])).toBe(0);
    await writeFile(path.join(root, "pg.log"), "");
    expect(await main(["restore", newer, "--home", path.join(root, "b")])).toBe(2);
    expect(last()).toMatchObject({ reason: "newer" });
    expect(await readdir(path.join(root, "b"))).toEqual([]);
    expect(await readFile(path.join(root, "pg.log"), "utf8")).toBe("");
  });

  it("restores only into a new installation", async () => {
    const home = path.join(root, "home");
    await usedHome(home, { running: true });
    const file = path.join(root, "b.dozo");
    expect(await main(["create", file, "--home", home])).toBe(0);
    expect(await main(["restore", file, "--home", home])).toBe(2);
    expect(last()).toMatchObject({ reason: "not-empty" });
    const used = path.join(root, "used");
    await mkdir(path.join(used, "data"), { recursive: true });
    await writeFile(path.join(used, "data/x"), "x");
    expect(await main(["restore", file, "--home", used])).toBe(2);
    expect(last()).toMatchObject({ reason: "not-empty" });
  });

  it("names a wrong password and leaves nothing behind", async () => {
    const home = path.join(root, "home");
    await usedHome(home, { running: true });
    const file = path.join(root, "b.dozo");
    expect(await main(["create", file, "--home", home])).toBe(0);
    const fresh = path.join(root, "fresh");
    expect(await main(["restore", file, "--home", fresh], "not the password")).toBe(2);
    expect(last()).toMatchObject({ reason: "wrong-password" });
    expect(await readdir(fresh)).toEqual([]);
  });

  it("refuses a backup without its database or description", async () => {
    const file = path.join(root, "thin.dozo");
    async function* entries() {
      const body = Buffer.from(JSON.stringify({ format: 1, server: "x", migrations: [] }));
      yield {
        path: "backup.json",
        kind: "file" as const,
        size: body.length,
        mode: 0o600,
        open: () => Readable.from([body]),
      };
    }
    await writeBackup(entries(), PASSWORD, createWriteStream(file), KDF);
    expect(await main(["restore", file, "--home", path.join(root, "a")])).toBe(2);
    expect(last()).toMatchObject({ reason: "no-backup-data" });

    const odd = path.join(root, "odd.dozo");
    async function* noDescription() {
      const body = Buffer.from("not json");
      yield {
        path: "backup.json",
        kind: "file" as const,
        size: body.length,
        mode: 0o600,
        open: () => Readable.from([body]),
      };
    }
    await writeBackup(noDescription(), PASSWORD, createWriteStream(odd), KDF);
    expect(await main(["restore", odd, "--home", path.join(root, "b")])).toBe(2);
    expect(last()).toMatchObject({ reason: "no-backup-data" });
  });

  it("refuses a folder without a server, and says why Postgres failed", async () => {
    expect(
      await main(["create", path.join(root, "x.dozo"), "--home", path.join(root, "none")]),
    ).toBe(2);
    expect(last()).toMatchObject({ reason: "no-server" });
    const home = path.join(root, "home");
    await usedHome(home);
    vi.stubEnv("FAKE_PG_FAIL", "start");
    expect(await main(["create", path.join(root, "x.dozo"), "--home", home])).toBe(2);
    expect(last()).toMatchObject({ reason: "failed", error: "pg_ctl failed: could not start" });
    expect((await readdir(root)).filter((name) => name.endsWith(".partial"))).toEqual([]);
    await writeFile(path.join(home, "secrets"), "ENCRYPTION_KEY=key\n");
    vi.stubEnv("FAKE_PG_FAIL", "");
    expect(await main(["create", path.join(root, "x.dozo"), "--home", home])).toBe(2);
    expect(last()).toMatchObject({ reason: "no-server" });
  });

  it("starts its own Postgres when the app left a stale pid file, and reports a failed stop", async () => {
    const home = path.join(root, "home");
    await usedHome(home);
    // A process that no longer exists: what a crashed app leaves.
    await writeFile(path.join(home, "pgdata/postmaster.pid"), "2147483646\n/x\n0\n54321\n");
    expect(await main(["create", path.join(root, "a.dozo"), "--home", home])).toBe(0);
    expect((await log())[0]).toMatch(/^pg_ctl .*start$/);
    vi.stubEnv("FAKE_PG_FAIL", "stop");
    expect(await main(["create", path.join(root, "b.dozo"), "--home", home])).toBe(2);
    expect(last()).toMatchObject({ error: "pg_ctl failed: could not stop" });
  });

  it("refuses to back up a file name a restore could not take", async () => {
    const home = path.join(root, "home");
    await usedHome(home, { running: true });
    await writeFile(path.join(home, "data", "a\\b"), "x");
    expect(await main(["create", path.join(root, "a.dozo"), "--home", home])).toBe(2);
    expect(last().error).toContain("cannot be stored");
    expect((await readdir(root)).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("answers usage errors with 64", async () => {
    expect(await main([])).toBe(64);
    expect(await main(["create", "x"])).toBe(64);
    expect(await main(["delete", "x", "--home", root])).toBe(64);
    expect(await main(["create", "x", "--home", root], "short")).toBe(64);
    expect(last()).toMatchObject({ reason: "usage" });
  });

  it("runs as a process with the bundle's Postgres beside the server folder", async () => {
    const home = path.join(root, "home");
    await usedHome(home, { running: true });
    const written: string[] = [];
    const proc = (env: NodeJS.ProcessEnv) =>
      ({
        argv: ["node", "backup", "create", path.join(root, "p.dozo"), "--home", home],
        env,
        stdin: Readable.from([`${PASSWORD}\n`]),
        stdout: { write: (text: string) => written.push(text) },
      }) as unknown as NodeJS.Process;
    // The bundle's layout: <version>/server/rakazo-server/ next to <version>/postgres/bin.
    const bundled = path.join(root, "v", "server", "rakazo-server");
    await mkdir(path.join(root, "v", "postgres"), { recursive: true });
    await mkdir(path.dirname(bundled), { recursive: true });
    await symlink(serverDir, bundled);
    await symlink(pgBin, path.join(root, "v", "postgres", "bin"));
    const here = pathToFileURL(path.join(bundled, "dozo-local-backup.mjs")).href;
    expect(await localBackupProcess(proc({}), here)).toBe(0);
    expect(JSON.parse(written[0] ?? "{}")).toMatchObject({ server: "0.11.0-1" });
    const env = { DOZO_SERVER_DIR: serverDir, DOZO_PG_BIN: path.join(root, "nowhere") };
    expect(await localBackupProcess(proc(env), here)).toBe(2);
  });
});
