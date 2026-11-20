import { randomBytes, scrypt } from "node:crypto";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@rakazo/core";
import {
  DATABASE,
  exists,
  LocalRefused,
  ownerPassword,
  pgTool,
  readLine,
  secretsFile,
  UsageError,
  withPostgres,
} from "./dozo-local-postgres.js";

/**
 * Sets a new password for a local server's account, from the computer it runs on. A local server
 * sends no email, so a forgotten password has no other way back. Nothing on the network can reach
 * this: it is a command, run by whoever can read the folder's secrets file (0600, the person who
 * installed it), and it works with the server running or stopped. It ends every session of the
 * account and writes the change to the security and audit logs. Contract:
 * `dozo/server-bundle/README.md`, "Password reset".
 */

const USAGE = 64;
const FAILED = 2;
/** The `providerId` of an email-and-password sign-in in the account table. */
const CREDENTIAL = "credential";
const VIA = "local-reset";

export type ResetIo = {
  write(line: string): void;
  stdin: NodeJS.ReadableStream;
  /** Postgres's `bin/` folder from the bundle. */
  pgBin: string;
  env: NodeJS.ProcessEnv;
  /** This process's user id, or `undefined` where there is none (Windows). */
  uid: number | undefined;
};

type Reason = "no-server" | "no-account" | "several-accounts" | "hosted-login" | "not-owner";

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

/** Ids go into the SQL text below, so only the characters the server's ids are made of pass. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function reset(home: string, password: string, io: ResetIo) {
  if (io.env.HOSTED_LOGIN_ISSUER) {
    throw new LocalRefused<Reason>(
      "hosted-login",
      "This Dozo signs in with your Dozo account, which has no password here. Reset it on the Dozo website.",
    );
  }
  const secrets = await secretsFile(home);
  const pgdata = path.join(home, "pgdata");
  if (!secrets || !(await exists(path.join(pgdata, "PG_VERSION")))) {
    throw new LocalRefused<Reason>("no-server", "This folder has no Dozo server.");
  }
  // Reading the secrets file is the permission; a file someone else owns is not this person's.
  const owner = (await stat(path.join(home, secrets))).uid;
  if (io.uid !== undefined && io.uid !== 0 && owner !== io.uid) {
    throw new LocalRefused<Reason>("not-owner", "Run this as the person who installed this Dozo.");
  }
  const hash = await hashPassword(password);
  const result = await withPostgres(
    io.pgBin,
    pgdata,
    await ownerPassword(path.join(home, secrets)),
    async (pg) => {
      const psql = (sql: string) =>
        pgTool(pg, "psql", ["-d", DATABASE, "-v", "ON_ERROR_STOP=1", "-Atc", sql]);
      const users = (
        await psql(
          `SELECT u.id, count(a.id) FROM "user" u LEFT JOIN account a ON a."userId" = u.id AND a."providerId" = '${CREDENTIAL}' GROUP BY u.id`,
        )
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("|"));
      if (users.length === 0) {
        throw new LocalRefused<Reason>("no-account", "This Dozo has no account yet.");
      }
      if (users.length > 1) {
        throw new LocalRefused<Reason>(
          "several-accounts",
          "This Dozo has more than one account; it was not set up by the app.",
        );
      }
      const [id = "", credentials = "0"] = users[0] as string[];
      if (!SAFE_ID.test(id)) throw new Error("the account id has unexpected characters");
      if (credentials === "0") {
        throw new LocalRefused<Reason>(
          "hosted-login",
          "This Dozo signs in with your Dozo account, which has no password here. Reset it on the Dozo website.",
        );
      }
      const metadata = JSON.stringify({ via: VIA });
      // One statement: the password, the end of every session and both log rows, or none.
      const [, ended = "0"] = (
        await psql(`WITH changed AS (
  UPDATE account SET password = '${hash}', "updatedAt" = now()
  WHERE "userId" = '${id}' AND "providerId" = '${CREDENTIAL}' RETURNING 1
), ended AS (
  DELETE FROM session WHERE "userId" = '${id}' RETURNING 1
), security AS (
  INSERT INTO security_events (id, type, "userId", metadata)
  VALUES (gen_random_uuid()::text, 'auth.password.changed', '${id}', '${metadata}') RETURNING 1
), audit AS (
  INSERT INTO audit_events (id, "organizationId", "actorType", "actorLabel", action, "targetType", "targetId", "targetLabel", outcome, metadata)
  SELECT gen_random_uuid()::text, m."organizationId", 'system', '${VIA}', 'auth.password.changed', 'user', u.id, left(u.email, 200), 'success', '${metadata}'
  FROM member m JOIN "user" u ON u.id = m."userId" WHERE m."userId" = '${id}' AND m.role <> 'guest' RETURNING 1
)
SELECT (SELECT count(*) FROM changed), (SELECT count(*) FROM ended), (SELECT count(*) FROM security), (SELECT count(*) FROM audit)`)
      )
        .trim()
        .split("|");
      return { sessionsEnded: Number(ended) };
    },
  );
  io.write(JSON.stringify({ reset: true, ...result }));
}

/** Runs the command and returns the exit code: 0 done, 2 failed, 64 usage error. */
export async function localResetPasswordMain(argv: string[], io: ResetIo): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { home: { type: "string" } },
    });
    if (positionals.length > 0 || !values.home) {
      throw new UsageError("usage: reset-password --home <server folder> (new password on stdin)");
    }
    const password = await readNewPassword(io.stdin);
    await reset(path.resolve(values.home), password, io);
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
export function localResetPasswordProcess(
  proc: Pick<NodeJS.Process, "argv" | "env" | "stdin" | "stdout">,
  here = import.meta.url,
): Promise<number> {
  // In the bundle this file sits in the server folder, and Postgres in `../../postgres/bin`.
  const serverDir = proc.env.DOZO_SERVER_DIR ?? path.dirname(fileURLToPath(here));
  return localResetPasswordMain(proc.argv.slice(2), {
    write: (line) => proc.stdout.write(`${line}\n`),
    stdin: proc.stdin,
    pgBin: proc.env.DOZO_PG_BIN ?? path.join(serverDir, "..", "..", "postgres", "bin"),
    env: proc.env,
    uid: process.getuid?.(),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exitCode = await localResetPasswordProcess(process);
