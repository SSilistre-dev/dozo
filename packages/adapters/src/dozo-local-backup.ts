import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { BackupEntry, Kdf } from "./dozo-local-backup-format.js";
import {
  BackupFormatError,
  DEFAULT_KDF,
  extractBackup,
  safeEntryPath,
  writeBackup,
} from "./dozo-local-backup-format.js";
import {
  DATABASE,
  exe,
  exists,
  LocalRefused,
  ownerPassword,
  pgTool,
  readLine,
  run,
  SECRETS_FILES,
  secretsFile,
  serverVersion,
  UsageError,
  withPostgres,
} from "./dozo-local-postgres.js";

/**
 * Backs up and restores a local server's whole folder as one password-sealed file: the database
 * (a `pg_dump`), the server's files (`data/`), the secrets file with the encryption keys, and the
 * relay agent's keys (`relay/`). It ships in the server bundle (entrypoint `backup`) and runs with
 * the bundle's Node and Postgres. Commands, output and exit codes: `dozo/server-bundle/README.md`,
 * "Backup and restore".
 */

const USAGE = 64;
const FAILED = 2;
const MIN_PASSWORD = 8;
const FOLDERS = ["data", "relay"];
const MANIFEST = "backup.json";
const DUMP = "database.dump";

export type BackupIo = {
  write(line: string): void;
  stdin: NodeJS.ReadableStream;
  /** The installed bundle's server folder: its version and its migrations. */
  serverDir: string;
  /** Postgres's `bin/` folder from the same bundle. */
  pgBin: string;
  kdf?: Kdf;
};

type Manifest = { format: 1; createdAt: string; server: string; migrations: string[] };

/** A refusal the person can act on, with a stable reason the app can switch on. */
export class BackupRefused extends LocalRefused<
  "newer" | "not-empty" | "no-server" | "no-backup-data"
> {}

async function readPassword(stdin: NodeJS.ReadableStream): Promise<string> {
  const line = await readLine(stdin);
  if (line !== undefined && line.length >= MIN_PASSWORD) return line;
  throw new UsageError(`give a password of at least ${MIN_PASSWORD} characters on standard input`);
}

async function knownMigrations(serverDir: string): Promise<Set<string>> {
  const folder = path.join(serverDir, "packages/db/prisma/migrations");
  const entries = await readdir(folder, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

async function* tree(home: string, relative: string): AsyncGenerator<BackupEntry> {
  const full = path.join(home, relative);
  const info = await lstat(full).catch((error) => {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  try {
    safeEntryPath(relative);
  } catch {
    throw new Error(`${relative}: this file name cannot be stored in a backup; rename it`);
  }
  if (info.isFile()) {
    yield {
      path: relative,
      kind: "file",
      size: info.size,
      mode: info.mode,
      open: () => createReadStream(full),
    };
    return;
  }
  // Links and other special files are left out: a link could reach outside the folder.
  if (!info.isDirectory()) return;
  yield { path: relative, kind: "dir" };
  const names = (await readdir(full)).sort();
  for (const name of names) yield* tree(home, `${relative}/${name}`);
}

async function create(file: string, home: string, password: string, io: BackupIo) {
  const secrets = await secretsFile(home);
  const pgdata = path.join(home, "pgdata");
  if (!secrets || !(await exists(path.join(pgdata, "PG_VERSION")))) {
    throw new BackupRefused("no-server", "This folder has no Dozo server to back up.");
  }
  const work = await mkdtemp(path.join(home, "backup-"));
  const partial = `${path.resolve(file)}.${randomBytes(4).toString("hex")}.partial`;
  try {
    const dump = path.join(work, DUMP);
    const owner = await ownerPassword(path.join(home, secrets));
    const migrations = await withPostgres(io.pgBin, pgdata, owner, async (pg) => {
      await pgTool(pg, "pg_dump", ["-d", DATABASE, "-Fc", "-f", dump]);
      const names = await pgTool(pg, "psql", [
        "-d",
        DATABASE,
        "-Atc",
        "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1",
      ]);
      return names.split("\n").filter(Boolean);
    });
    const manifest: Manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      server: await serverVersion(io.serverDir),
      migrations,
    };
    await writeFile(path.join(work, MANIFEST), JSON.stringify(manifest));
    async function* entries(): AsyncGenerator<BackupEntry> {
      yield* tree(work, MANIFEST);
      yield* tree(home, secrets as string);
      yield* tree(work, DUMP);
      for (const folder of FOLDERS) yield* tree(home, folder);
    }
    const out = createWriteStream(partial, { flags: "wx", mode: 0o600 });
    await writeBackup(entries(), password, out, io.kdf ?? DEFAULT_KDF);
    await rename(partial, file);
    io.write(JSON.stringify({ created: path.resolve(file), server: manifest.server }));
  } finally {
    await rm(partial, { force: true });
    await rm(work, { recursive: true, force: true });
  }
}

async function emptyOrMissing(folder: string): Promise<boolean> {
  try {
    return (await readdir(folder)).length === 0;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return true;
    throw error;
  }
}

async function restore(file: string, home: string, password: string, io: BackupIo) {
  if (
    (await exists(path.join(home, "pgdata"))) ||
    !(await emptyOrMissing(path.join(home, "data")))
  ) {
    throw new BackupRefused(
      "not-empty",
      "This Dozo already has data. Restore into a new installation.",
    );
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  const known = await knownMigrations(io.serverDir);
  const work = await mkdtemp(path.join(home, "restore-"));
  try {
    let manifest: Manifest | undefined;
    // The manifest comes first: a newer backup is refused before the rest is read.
    await extractBackup(
      createReadStream(file),
      password,
      path.join(work, "files"),
      async (entry) => {
        if (entry !== MANIFEST || manifest) return;
        const text = await readFile(path.join(work, "files", MANIFEST), "utf8");
        try {
          manifest = JSON.parse(text);
        } catch {
          manifest = undefined;
        }
        if (manifest?.format !== 1 || !Array.isArray(manifest?.migrations)) {
          throw new BackupRefused("no-backup-data", "The backup has no description of itself.");
        }
        if (manifest.migrations.some((name) => !known.has(name))) {
          throw new BackupRefused(
            "newer",
            "This backup is from a newer Dozo. Update Dozo, then restore it.",
          );
        }
      },
    );
    const files = path.join(work, "files");
    const secrets = await secretsFile(files);
    if (!manifest || !secrets || !(await exists(path.join(files, DUMP)))) {
      throw new BackupRefused("no-backup-data", "The backup is missing the database or secrets.");
    }
    const owner = await ownerPassword(path.join(files, secrets));
    const pgdata = path.join(work, "pgdata");
    const pwfile = path.join(work, "pwfile");
    await writeFile(pwfile, owner, { mode: 0o600 });
    await run(path.join(io.pgBin, exe("initdb")), [
      "-D",
      pgdata,
      "-U",
      DATABASE,
      `--pwfile=${pwfile}`,
      "-A",
      "scram-sha-256",
      "-E",
      "UTF8",
      "--locale=C",
    ]);
    await rm(pwfile);
    await withPostgres(io.pgBin, pgdata, owner, async (pg) => {
      await pgTool(pg, "createdb", [DATABASE]);
      // Roles are not in a dump: the grants and policies in it name this one. The next start's
      // migration gives it its login and password, as on a first start.
      await pgTool(pg, "psql", [
        "-d",
        DATABASE,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "CREATE ROLE rakazo_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      ]);
      await pgTool(pg, "pg_restore", [
        "-d",
        DATABASE,
        "--exit-on-error",
        "--single-transaction",
        path.join(files, DUMP),
      ]);
    });
    // Everything is checked and the database loaded. Move it in, the database first: if an app
    // started on the folder meanwhile, that fails and nothing of the target has changed. The
    // secrets go last, so the target's own stay until the rest is in place.
    if (await exists(path.join(home, "pgdata"))) {
      throw new BackupRefused(
        "not-empty",
        "This Dozo already has data. Restore into a new installation.",
      );
    }
    await rename(pgdata, path.join(home, "pgdata"));
    for (const folder of FOLDERS) {
      if (!(await exists(path.join(files, folder)))) continue;
      if (await exists(path.join(home, folder))) await removeEmptyOrRefuse(path.join(home, folder));
      await rename(path.join(files, folder), path.join(home, folder));
    }
    for (const name of SECRETS_FILES) await rm(path.join(home, name), { force: true });
    await rename(path.join(files, secrets), path.join(home, secrets));
    const pending = [...known].some((name) => !manifest?.migrations.includes(name));
    io.write(
      JSON.stringify({ restored: path.resolve(file), server: manifest.server, migrate: pending }),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** `relay/` of a new installation may hold keys made on its first start; `data/` was checked. */
async function removeEmptyOrRefuse(folder: string) {
  if (path.basename(folder) === "relay") return rm(folder, { recursive: true, force: true });
  await rmdir(folder);
}

/** Runs one command and returns the exit code: 0 done, 2 failed, 64 usage error. */
export async function localBackupMain(argv: string[], io: BackupIo): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { home: { type: "string" } },
    });
    const [command, file] = positionals;
    if ((command !== "create" && command !== "restore") || !file || positionals.length !== 2) {
      throw new UsageError("usage: backup create|restore <file> --home <server folder>");
    }
    if (!values.home) throw new UsageError("--home <server folder> is required");
    const home = path.resolve(values.home);
    const password = await readPassword(io.stdin);
    if (command === "create") await create(file, home, password, io);
    else await restore(file, home, password, io);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.write(JSON.stringify({ error: error.message, reason: "usage" }));
      return USAGE;
    }
    const reason =
      error instanceof LocalRefused || error instanceof BackupFormatError ? error.reason : "failed";
    io.write(JSON.stringify({ error: (error as Error).message, reason }));
    return FAILED;
  }
}

/** The command as a process: arguments, environment and streams from `proc`. */
export function localBackupProcess(
  proc: Pick<NodeJS.Process, "argv" | "env" | "stdin" | "stdout">,
  here = import.meta.url,
): Promise<number> {
  // In the bundle this file sits in the server folder, and Postgres in `../../postgres/bin`.
  const serverDir = proc.env.DOZO_SERVER_DIR ?? path.dirname(fileURLToPath(here));
  return localBackupMain(proc.argv.slice(2), {
    write: (line) => proc.stdout.write(`${line}\n`),
    stdin: proc.stdin,
    serverDir,
    pgBin: proc.env.DOZO_PG_BIN ?? path.join(serverDir, "..", "..", "postgres", "bin"),
  });
}

// By real path: Node loads the module by its real path, and macOS's temporary folder (and any
// folder reached through a link) is not.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exitCode = await localBackupProcess(process);
