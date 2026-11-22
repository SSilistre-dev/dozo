import { randomBytes, scrypt } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, gzipSync } from "node:zlib";
import type { SealedDeriveKey } from "@rakazo/core";
import {
  openOneFile,
  openStream,
  SEALED_ACCOUNT_ENTRY,
  SealedFileError,
  sealOneFile,
  sealStream,
} from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localBackupMain } from "./dozo-local-backup.js";
import type { BackupEntry } from "./dozo-local-backup-format.js";
import {
  BackupFormatError,
  extractBackup,
  opener,
  sealer,
  writeBackup,
} from "./dozo-local-backup-format.js";

// The smallest cost the reader accepts, to keep the tests fast.
const KDF = { logN: 15, r: 8, p: 1 };
const PASSWORD = "a long enough password";
const LIMIT = { path: SEALED_ACCOUNT_ENTRY, maxSize: 4 * 1024 ** 3 };

const deriveKey: SealedDeriveKey = (password, salt, kdf) =>
  new Promise((resolve, reject) => {
    const N = 2 ** kdf.logN;
    scrypt(password, salt, 32, { N, r: kdf.r, p: kdf.p, maxmem: 256 * N * kdf.r }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dozo-sealed-compat-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const webStream = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)]).stream();

/** What the browser downloads for an account backup, written to a file here. */
async function sealedInBrowser(zip: Buffer): Promise<string> {
  const file = path.join(dir, "account.dozobackup");
  const sealed = sealOneFile(
    { path: SEALED_ACCOUNT_ENTRY, size: zip.length, mode: 0o600 },
    webStream(zip),
    PASSWORD,
    deriveKey,
    KDF,
  );
  await pipeline(Readable.fromWeb(sealed as never), createWriteStream(file));
  return file;
}

async function openInBrowser(file: string): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  const sealed = webStream(await readFile(file));
  for await (const part of openOneFile(sealed, PASSWORD, deriveKey, LIMIT)) parts.push(part);
  return Buffer.concat(parts);
}

function entry(name: string, body: Buffer): BackupEntry {
  return {
    path: name,
    kind: "file",
    size: body.length,
    mode: 0o600,
    open: () => Readable.from([body]),
  };
}

async function sealedOnServer(entries: BackupEntry[]): Promise<string> {
  const file = path.join(dir, "server.dozo");
  async function* list() {
    yield* entries;
  }
  await writeBackup(list(), PASSWORD, createWriteStream(file), KDF);
  return file;
}

describe("one backup format in the browser and on a local server", () => {
  it("the local server opens what the browser sealed", async () => {
    const zip = randomBytes(200 * 1024);
    const file = await sealedInBrowser(zip);
    const out = path.join(dir, "out");
    expect(await extractBackup(createReadStream(file), PASSWORD, out)).toEqual([
      SEALED_ACCOUNT_ENTRY,
    ]);
    expect((await readFile(path.join(out, SEALED_ACCOUNT_ENTRY))).equals(zip)).toBe(true);
    await expect(
      extractBackup(createReadStream(file), "another password", path.join(dir, "no")),
    ).rejects.toMatchObject({ reason: "wrong-password" });
  });

  it("the browser opens what the local server sealed", async () => {
    const zip = randomBytes(200 * 1024);
    const file = await sealedOnServer([entry(SEALED_ACCOUNT_ENTRY, zip)]);
    expect((await openInBrowser(file)).equals(zip)).toBe(true);
  });

  it("each opener reads the other's raw sealed stream", async () => {
    const plain = randomBytes(150 * 1024);
    const webSealed = Buffer.from(
      await new Response(
        webStream(plain).pipeThrough(sealStream(PASSWORD, deriveKey, KDF)),
      ).arrayBuffer(),
    );
    const chunks: Buffer[] = [];
    await pipeline(Readable.from([webSealed]), opener(PASSWORD), async (source) => {
      for await (const chunk of source) chunks.push(chunk as Buffer);
    });
    expect(Buffer.concat(chunks).equals(plain)).toBe(true);

    const nodeSealed = path.join(dir, "raw.dozo");
    await pipeline(
      Readable.from([plain]),
      await sealer(PASSWORD, KDF),
      createWriteStream(nodeSealed),
    );
    const opened = webStream(await readFile(nodeSealed)).pipeThrough(
      openStream(PASSWORD, deriveKey),
    );
    expect(Buffer.from(await new Response(opened).arrayBuffer()).equals(plain)).toBe(true);
    expect(BackupFormatError).toBe(SealedFileError);
  });

  it("a local restore refuses an account backup, which has no server data", async () => {
    const file = await sealedInBrowser(Buffer.from("zip"));
    const serverDir = path.join(dir, "rakazo-server");
    await mkdir(path.join(serverDir, "packages/db/prisma/migrations"), { recursive: true });
    const lines: string[] = [];
    const home = path.join(dir, "home");
    const code = await localBackupMain(["restore", file, "--home", home], {
      write: (line) => lines.push(line),
      stdin: Readable.from([`${PASSWORD}\n`]),
      serverDir,
      pgBin: path.join(dir, "no-postgres"),
      kdf: KDF,
    });
    expect(code).toBe(2);
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ reason: "no-backup-data" });
    // Nothing of the account backup is left in the server folder.
    expect((await readdir(home)).filter((name) => name.startsWith("restore-"))).toEqual([]);
  });

  it("the browser refuses a local server's backup", async () => {
    const file = await sealedOnServer([
      entry("backup.json", Buffer.from('{"format":1,"migrations":[]}')),
      entry("secrets", Buffer.from("KEY=value")),
    ]);
    await expect(openInBrowser(file)).rejects.toMatchObject({
      reason: "wrong-password",
      message: "Wrong password, or the file was changed.",
    });
    await expect(openInBrowser(file)).rejects.toBeInstanceOf(SealedFileError);
  });

  it("gunzips the browser's body like the server's", async () => {
    const zip = randomBytes(10);
    const file = await sealedInBrowser(zip);
    const chunks: Buffer[] = [];
    await pipeline(createReadStream(file), opener(PASSWORD), createGunzip(), async (source) => {
      for await (const chunk of source) chunks.push(chunk as Buffer);
    });
    const archive = Buffer.concat(chunks);
    const length = archive.readUInt32BE(0);
    expect(JSON.parse(archive.subarray(4, 4 + length).toString())).toEqual({
      path: SEALED_ACCOUNT_ENTRY,
      kind: "file",
      size: 10,
      mode: 0o600,
    });
    expect(archive.subarray(4 + length, 14 + length).equals(zip)).toBe(true);
    expect(archive.subarray(14 + length)).toEqual(Buffer.alloc(4));
  });
});

describe("the local server's reader on the shared definitions", () => {
  const extract = (file: string) =>
    extractBackup(createReadStream(file), PASSWORD, path.join(dir, "edge-out"));

  async function sealedRaw(plain: Buffer): Promise<string> {
    const file = path.join(dir, "raw-edge.dozo");
    await pipeline(Readable.from([plain]), await sealer(PASSWORD, KDF), createWriteStream(file));
    return file;
  }

  it("reads a header split across reads, and refuses a last chunk shorter than its tag", async () => {
    const zip = randomBytes(1000);
    const sealed = await readFile(await sealedInBrowser(zip));
    const chunks: Buffer[] = [];
    const pieces = [sealed.subarray(0, 10), sealed.subarray(10)];
    await pipeline(Readable.from(pieces), opener(PASSWORD), createGunzip(), async (source) => {
      for await (const chunk of source) chunks.push(chunk as Buffer);
    });
    expect(Buffer.concat(chunks).includes(zip)).toBe(true);
    const short = path.join(dir, "short.dozo");
    await writeFile(short, sealed.subarray(0, 28 + 5));
    await expect(extract(short)).rejects.toMatchObject({ reason: "damaged" });
  });

  it("refuses an archive cut short inside its first length", async () => {
    await expect(extract(await sealedRaw(gzipSync(Buffer.from([0, 0, 0]))))).rejects.toMatchObject({
      reason: "damaged",
    });
  });

  it("fails a backup whose file shrank or whose cost scrypt refuses", async () => {
    const out = createWriteStream(path.join(dir, "shrank.dozo"));
    const shrank: BackupEntry = { ...entry("a", Buffer.from("ab")), size: 3 } as BackupEntry;
    await expect(
      writeBackup(
        (async function* () {
          yield shrank;
        })(),
        PASSWORD,
        out,
        KDF,
      ),
    ).rejects.toThrow("shrank");
    await expect(sealer(PASSWORD, { logN: 40, r: 8, p: 1 })).rejects.toThrow();
  });
});
