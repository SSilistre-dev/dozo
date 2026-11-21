import { randomBytes, scrypt } from "node:crypto";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@rakazo/core";
import {
  LocalRefused,
  readLine,
  secretsFile,
  UsageError,
  withHomeDatabase,
} from "./dozo-local-postgres.js";

/**
 * Account repairs for a computer's own server, run on that computer against its folder, so only
 * whoever can reach the folder can make them; nothing on the network can start them. It ships in
 * the server bundle (entrypoint `account`) and runs with the bundle's Node and Postgres, the app
 * open or closed. Commands, output and exit codes: `dozo/server-bundle/README.md`, "Account
 * repairs".
 *
 * `unlink-hosted` removes every link to a hosted account, ends those users' sessions and marks each
 * user so the next hosted sign-in on that computer links it again, whichever hosted account it
 * is (`packages/auth/src/dozo-hosted-login.ts`). Each user stays with their data. It is the way
 * back when the linked hosted account was deleted or cannot sign in any more.
 *
 * `reset-password` sets a new password (first line of standard input) for the folder's one
 * account: a local server sends no email, so a forgotten password has no other way back. It ends
 * every session of the account and writes the change to the security and audit logs. Only the
 * person who owns the folder's secrets file (0600) may run it.
 */

const USAGE = 64;
const FAILED = 2;
const HOSTED_PROVIDER_ID = "dozo-hosted";
/** The `providerId` of an email-and-password sign-in in the account table. */
const CREDENTIAL = "credential";
const VIA = "local-reset";
const USAGE_LINE =
  "usage: account unlink-hosted|reset-password --home <server folder> (reset-password: new password on stdin)";

export type AccountIo = {
  write(line: string): void;
  /** Postgres's `bin/` folder from the same bundle. */
  pgBin: string;
  /** Where `reset-password` reads the new password. */
  stdin?: NodeJS.ReadableStream;
  env?: NodeJS.ProcessEnv;
  /** This process's user id, or `undefined` where there is none (Windows). */
  uid?: number;
};

/** The mark the hosted login reads (`ADOPT_PREFIX` in `packages/auth/src/dozo-hosted-login.ts`). */
const ADOPT_USER = "dozo-hosted-adopt:user:";

/**
 * In one statement: the links go, those users' sessions end, and each user is marked so the next
 * hosted sign-in links it again.
 */
const UNLINK_SQL = `WITH gone AS (DELETE FROM "account" WHERE "providerId" = '${HOSTED_PROVIDER_ID}' RETURNING "userId"),
ended AS (DELETE FROM "session" WHERE "userId" IN (SELECT "userId" FROM gone) RETURNING 1),
marked AS (INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, '${ADOPT_USER}' || "userId", '1', now() + interval '10 years', now(), now()
  FROM (SELECT DISTINCT "userId" FROM gone) AS users RETURNING 1)
SELECT (SELECT count(*) FROM gone) || ' ' || (SELECT count(*) FROM ended) || ' ' || (SELECT count(*) FROM marked)`;

/**
 * The password hash the server's sign-in checks: scrypt (N 16384, r 16, p 1, 64 bytes) of the
 * NFKC password with a random 16-byte salt used as its hex text, written `salt:key` in hex. The
 * test checks a hash the sign-in library made; the smoke test signs in with one made here.
 */
export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return new Promise<string>((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      64,
      { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 },
      (error, key) => (error ? reject(error) : resolve(`${salt}:${key.toString("hex")}`)),
    );
  });
}

const HOSTED_ONLY =
  "This Dozo signs in with your Dozo account, which has no password here. Reset it on the Dozo website.";
/** Ids go into the SQL text below, so only the characters the server's ids are made of pass. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function readNewPassword(stdin: NodeJS.ReadableStream): Promise<string> {
  const line = await readLine(stdin);
  if (
    line !== undefined &&
    line.length >= MIN_PASSWORD_LENGTH &&
    line.length <= MAX_PASSWORD_LENGTH
  ) {
    return line;
  }
  throw new UsageError(
    `give the new password, ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters, on standard input`,
  );
}

const resetSql = (id: string, hash: string) => {
  const metadata = JSON.stringify({ via: VIA });
  // One statement: the password, the end of every session and both log rows, or none.
  return `WITH changed AS (
  UPDATE account SET password = '${hash}', "updatedAt" = now()
  WHERE "userId" = '${id}' AND "providerId" = '${CREDENTIAL}' RETURNING 1
), ended AS (
  DELETE FROM session WHERE "userId" = '${id}' RETURNING 1
), security AS (
  INSERT INTO security_events (id, type, "userId", metadata, "createdAt")
  VALUES (gen_random_uuid()::text, 'auth.password.changed', '${id}', '${metadata}',
    now() AT TIME ZONE 'UTC') RETURNING 1
), audit AS (
  INSERT INTO audit_events (id, "organizationId", "actorType", "actorLabel", action, "targetType", "targetId", "targetLabel", outcome, metadata)
  SELECT gen_random_uuid()::text, m."organizationId", 'system', '${VIA}', 'auth.password.changed', 'user', u.id, left(u.email, 200), 'success', '${metadata}'
  FROM member m JOIN "user" u ON u.id = m."userId" WHERE m."userId" = '${id}' AND m.role <> 'guest' RETURNING 1
)
SELECT (SELECT count(*) FROM changed), (SELECT count(*) FROM ended), (SELECT count(*) FROM security), (SELECT count(*) FROM audit)`;
};

async function resetPassword(home: string, io: AccountIo) {
  if (io.env?.HOSTED_LOGIN_ISSUER) throw new LocalRefused("hosted-login", HOSTED_ONLY);
  const password = await readNewPassword(io.stdin ?? Readable.from([]));
  // Reading the secrets file is the permission; a file someone else owns is not this person's.
  const secrets = await secretsFile(home);
  if (secrets && io.uid !== undefined && io.uid !== 0) {
    if ((await stat(path.join(home, secrets))).uid !== io.uid) {
      throw new LocalRefused("not-owner", "Run this as the person who installed this Dozo.");
    }
  }
  const hash = await hashPassword(password);
  const sessionsEnded = await withHomeDatabase(home, io.pgBin, async (run) => {
    const psql = (sql: string) => run(["-v", "ON_ERROR_STOP=1", "-Atc", sql]);
    const users = (
      await psql(
        `SELECT u.id, count(a.id) FROM "user" u LEFT JOIN account a ON a."userId" = u.id AND a."providerId" = '${CREDENTIAL}' GROUP BY u.id`,
      )
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"));
    if (users.length === 0) throw new LocalRefused("no-account", "This Dozo has no account yet.");
    if (users.length > 1) {
      throw new LocalRefused(
        "several-accounts",
        "This Dozo has more than one account; it was not set up by the app.",
      );
    }
    const [id = "", credentials = "0"] = users[0] as string[];
    if (!SAFE_ID.test(id)) throw new Error("the account id has unexpected characters");
    if (credentials === "0") throw new LocalRefused("hosted-login", HOSTED_ONLY);
    const [, ended = "0"] = (await psql(resetSql(id, hash))).trim().split("|");
    return Number(ended);
  });
  io.write(JSON.stringify({ reset: true, sessionsEnded }));
}

async function unlinkHosted(home: string, io: AccountIo) {
  const counts = await withHomeDatabase(home, io.pgBin, (psql) =>
    psql(["-v", "ON_ERROR_STOP=1", "-Atc", UNLINK_SQL]),
  );
  const [unlinked = 0, sessionsEnded = 0] = counts.trim().split(" ").map(Number);
  io.write(JSON.stringify({ unlinked, sessionsEnded }));
}

const COMMANDS: Record<string, (home: string, io: AccountIo) => Promise<void>> = {
  "unlink-hosted": unlinkHosted,
  "reset-password": resetPassword,
};

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
    const command = positionals.length === 1 ? COMMANDS[positionals[0] as string] : undefined;
    if (!command) throw new UsageError(USAGE_LINE);
    if (!values.home) throw new UsageError("--home <server folder> is required");
    await command(path.resolve(values.home), io);
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
export function localAccountProcess(
  proc: Pick<NodeJS.Process, "argv" | "env" | "stdout"> & Partial<Pick<NodeJS.Process, "stdin">>,
  here = import.meta.url,
): Promise<number> {
  // In the bundle this file sits in the server folder, and Postgres in `../../postgres/bin`.
  const serverDir = proc.env.DOZO_SERVER_DIR ?? path.dirname(fileURLToPath(here));
  return localAccountMain(proc.argv.slice(2), {
    write: (line) => proc.stdout.write(`${line}\n`),
    pgBin: proc.env.DOZO_PG_BIN ?? path.join(serverDir, "..", "..", "postgres", "bin"),
    stdin: proc.stdin,
    env: proc.env,
    uid: process.getuid?.(),
  });
}

// By real path, as the backup command does.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exitCode = await localAccountProcess(process);
