import { execFile } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * What the local server's own commands (backup, password reset, diagnostics) share: its folder's
 * layout, its secrets file, its Postgres, and one line read from standard input. Layout and start
 * contract: `dozo/server-bundle/README.md`.
 */

/** The desktop app writes `secrets`, `run.sh` writes `secrets.env`; both are `KEY=value` lines. */
export const SECRETS_FILES = ["secrets", "secrets.env"];
/** The local server's database and the role that owns it. */
export const DATABASE = "rakazo";

/** A refusal the person can act on, with a stable reason the app can switch on. */
export class LocalRefused<Reason extends string = string> extends Error {
  constructor(
    readonly reason: Reason,
    message: string,
  ) {
    super(message);
  }
}

/** A wrong call: the command answers with its usage and exit 64. */
export class UsageError extends Error {}

export const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

export function run(
  program: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const said = stderr.trim().split("\n").slice(-3).join(" ");
        reject(new Error(`${path.basename(program)} failed: ${said || error.message}`));
      },
    );
  });
}

/** The first line of standard input, or `undefined` when there is none. */
export async function readLine(stdin: NodeJS.ReadableStream): Promise<string | undefined> {
  const lines = createInterface({ input: stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    lines.close();
    return line;
  }
  return undefined;
}

export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

/** The name of the folder's secrets file, if it has one. */
export async function secretsFile(home: string): Promise<string | undefined> {
  for (const name of SECRETS_FILES) if (await exists(path.join(home, name))) return name;
  return undefined;
}

/** The secrets file's `KEY=value` lines; the value is everything after the first `=`. */
export async function readSecrets(file: string): Promise<Map<string, string>> {
  const secrets = new Map<string, string>();
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) secrets.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return secrets;
}

export async function ownerPassword(file: string): Promise<string> {
  const password = (await readSecrets(file)).get("PG_OWNER_PASSWORD");
  if (password) return password;
  throw new LocalRefused("no-server", "The secrets file has no PG_OWNER_PASSWORD.");
}

export async function serverVersion(serverDir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(serverDir, "manifest.json"), "utf8"));
  return String(manifest.version);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

export type Postgres = { port: number; password: string; pgBin: string };

/** Whether the process `postmaster.pid` names is alive; a crashed app leaves the file behind. */
export function alive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

/** The running Postgres of a data folder: pid and port, lines 1 and 4 of `postmaster.pid`. */
export async function runningPostgres(
  pgdata: string,
): Promise<{ pid: number; port: number } | undefined> {
  const pid = await readFile(path.join(pgdata, "postmaster.pid"), "utf8").catch((error) => {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  });
  const [owner = 0, , , port = 0] = (pid ?? "").split("\n").map(Number);
  return alive(owner) && port > 0 ? { pid: owner, port } : undefined;
}

/**
 * Runs `work` against the folder's Postgres: the one already running (the app is open), or one
 * started here on a free loopback port and stopped after.
 */
export async function withPostgres<T>(
  pgBin: string,
  pgdata: string,
  password: string,
  work: (pg: Postgres) => Promise<T>,
): Promise<T> {
  const running = await runningPostgres(pgdata);
  if (running) return work({ port: running.port, password, pgBin });
  const port = await freePort();
  const log = path.join(path.dirname(pgdata), `postgres-${port}.log`);
  // Also after a start that timed out, which can leave Postgres running.
  const stop = async () => {
    const failure = await run(path.join(pgBin, exe("pg_ctl")), [
      "-D",
      pgdata,
      "-m",
      "fast",
      "-w",
      "stop",
    ]).then(
      () => undefined,
      (error: unknown) => error,
    );
    await rm(log, { force: true });
    return failure;
  };
  let result: T;
  try {
    await run(path.join(pgBin, exe("pg_ctl")), [
      "-D",
      pgdata,
      "-w",
      "-t",
      "60",
      "-l",
      log,
      "-o",
      // In UTC, as the server itself starts it (dozo/server-bundle/README.md, "Start contract").
      `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c timezone=UTC`,
      "start",
    ]);
    result = await work({ port, password, pgBin });
  } catch (error) {
    // A stop that fails after this says less than this failure, which is what propagates.
    await stop();
    throw error;
  }
  const stopped = await stop();
  if (stopped) throw stopped;
  return result;
}

export function pgTool(pg: Postgres, name: string, args: string[]): Promise<string> {
  return run(
    path.join(pg.pgBin, exe(name)),
    ["-h", "127.0.0.1", "-p", String(pg.port), "-U", DATABASE, ...args],
    { PGPASSWORD: pg.password, PGCONNECT_TIMEOUT: "10" },
  );
}

/**
 * Runs `work` with `psql` on a server folder's database as its owner, the app open or closed. A
 * folder without a server is refused (`no-server`).
 */
export async function withHomeDatabase<T>(
  home: string,
  pgBin: string,
  work: (psql: (args: string[]) => Promise<string>) => Promise<T>,
): Promise<T> {
  const secrets = await secretsFile(home);
  const pgdata = path.join(home, "pgdata");
  if (!secrets || !(await exists(path.join(pgdata, "PG_VERSION")))) {
    throw new LocalRefused("no-server", "This folder has no Dozo server.");
  }
  const owner = await ownerPassword(path.join(home, secrets));
  return withPostgres(pgBin, pgdata, owner, (pg) =>
    work((args) => pgTool(pg, "psql", ["-d", DATABASE, ...args])),
  );
}
