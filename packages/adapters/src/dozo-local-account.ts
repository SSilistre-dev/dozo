import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { BackupRefused, withHomeDatabase } from "./dozo-local-backup.js";

/**
 * Account repairs for a computer's own server, run on that computer against its folder, so only
 * whoever can reach the folder can make them. It ships in the server bundle (entrypoint
 * `account`) and runs with the bundle's Node and Postgres, the app open or closed. Commands,
 * output and exit codes: `dozo/server-bundle/README.md`, "Account repairs".
 *
 * `unlink-hosted` removes every link to a hosted account and ends those users' sessions. Each
 * user stays with their data; the next hosted sign-in on that computer links the user again
 * (`packages/auth/src/dozo-hosted-login.ts`), whichever hosted account it is. It is the way back
 * when the linked hosted account was deleted or cannot sign in any more.
 */

const USAGE = 64;
const FAILED = 2;
const HOSTED_PROVIDER_ID = "dozo-hosted";

export type AccountIo = {
  write(line: string): void;
  /** Postgres's `bin/` folder from the same bundle. */
  pgBin: string;
};

class UsageError extends Error {}

const UNLINK_SQL = `WITH gone AS (DELETE FROM "account" WHERE "providerId" = '${HOSTED_PROVIDER_ID}' RETURNING "userId"),
ended AS (DELETE FROM "session" WHERE "userId" IN (SELECT "userId" FROM gone) RETURNING 1)
SELECT (SELECT count(*) FROM gone) || ' ' || (SELECT count(*) FROM ended)`;

function parseArguments(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: { home: { type: "string" } } });
  } catch (error) {
    // An unknown option or a missing value: the usage line, like any other wrong call.
    throw new UsageError((error as Error).message);
  }
}

/** Runs one command and returns the exit code: 0 done, 2 failed, 64 usage error. */
export async function localAccountMain(argv: string[], io: AccountIo): Promise<number> {
  try {
    const { positionals, values } = parseArguments(argv);
    if (positionals.length !== 1 || positionals[0] !== "unlink-hosted") {
      throw new UsageError("usage: account unlink-hosted --home <server folder>");
    }
    if (!values.home) throw new UsageError("--home <server folder> is required");
    const counts = await withHomeDatabase(path.resolve(values.home), io.pgBin, (psql) =>
      psql(["-v", "ON_ERROR_STOP=1", "-Atc", UNLINK_SQL]),
    );
    const [unlinked = 0, sessionsEnded = 0] = counts.trim().split(" ").map(Number);
    io.write(JSON.stringify({ unlinked, sessionsEnded }));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.write(JSON.stringify({ error: error.message, reason: "usage" }));
      return USAGE;
    }
    const reason = error instanceof BackupRefused ? error.reason : "failed";
    io.write(JSON.stringify({ error: (error as Error).message, reason }));
    return FAILED;
  }
}

/** The command as a process: arguments, environment and output from `proc`. */
export function localAccountProcess(
  proc: Pick<NodeJS.Process, "argv" | "env" | "stdout">,
  here = import.meta.url,
): Promise<number> {
  // In the bundle this file sits in the server folder, and Postgres in `../../postgres/bin`.
  const serverDir = proc.env.DOZO_SERVER_DIR ?? path.dirname(fileURLToPath(here));
  return localAccountMain(proc.argv.slice(2), {
    write: (line) => proc.stdout.write(`${line}\n`),
    pgBin: proc.env.DOZO_PG_BIN ?? path.join(serverDir, "..", "..", "postgres", "bin"),
  });
}

// By real path, as the backup command does.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exitCode = await localAccountProcess(process);
