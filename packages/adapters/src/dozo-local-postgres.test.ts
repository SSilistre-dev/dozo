import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  alive,
  exists,
  LocalRefused,
  ownerPassword,
  readSecrets,
  runningPostgres,
  secretsFile,
} from "./dozo-local-postgres.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dozo-local-pg-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local server folder", () => {
  it("reads either secrets file, values whole", async () => {
    expect(await secretsFile(root)).toBeUndefined();
    await writeFile(
      path.join(root, "secrets.env"),
      "A=b=c\n\nNOEQUALS\n PG_OWNER_PASSWORD = pw \n",
    );
    expect(await secretsFile(root)).toBe("secrets.env");
    const secrets = await readSecrets(path.join(root, "secrets.env"));
    expect(secrets.get("A")).toBe("b=c");
    expect(secrets.has("NOEQUALS")).toBe(false);
    expect(await ownerPassword(path.join(root, "secrets.env"))).toBe("pw");
    await writeFile(path.join(root, "secrets"), "OTHER=1\n");
    expect(await secretsFile(root)).toBe("secrets");
    await expect(ownerPassword(path.join(root, "secrets"))).rejects.toBeInstanceOf(LocalRefused);
  });

  it("tells a missing file from one that cannot be looked at", async () => {
    await writeFile(path.join(root, "file"), "");
    expect(await exists(path.join(root, "file"))).toBe(true);
    expect(await exists(path.join(root, "missing"))).toBe(false);
    await expect(exists(path.join(root, "file", "below"))).rejects.toThrow(/ENOTDIR/);
  });

  it("finds the running Postgres only when its process lives", async () => {
    const pgdata = path.join(root, "pgdata");
    await mkdir(pgdata);
    expect(await runningPostgres(pgdata)).toBeUndefined();
    await writeFile(path.join(pgdata, "postmaster.pid"), `${process.pid}\n/x\n0\n5432\n`);
    expect(await runningPostgres(pgdata)).toEqual({ pid: process.pid, port: 5432 });
    await writeFile(path.join(pgdata, "postmaster.pid"), "0\n/x\n0\n5432\n");
    expect(await runningPostgres(pgdata)).toBeUndefined();
    expect(alive(2 ** 22 + 1)).toBe(false);
    await expect(runningPostgres(path.join(root, "pgdata", "postmaster.pid"))).rejects.toThrow(
      /ENOTDIR/,
    );
  });
});
