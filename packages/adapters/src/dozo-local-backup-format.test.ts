import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackupEntry, Kdf } from "./dozo-local-backup-format.js";
import {
  extractBackup,
  opener,
  safeEntryPath,
  sealer,
  writeBackup,
} from "./dozo-local-backup-format.js";

// The smallest cost the reader accepts, to keep the tests fast.
const KDF: Kdf = { logN: 15, r: 8, p: 1 };
const PASSWORD = "correct horse battery";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dozo-backup-format-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function file(name: string, body: Buffer, mode = 0o600): BackupEntry {
  return { path: name, kind: "file", size: body.length, mode, open: () => Readable.from([body]) };
}

async function* list(entries: BackupEntry[]): AsyncGenerator<BackupEntry> {
  yield* entries;
}

async function seal(entries: BackupEntry[], name = "backup.dozo"): Promise<string> {
  const out = path.join(dir, name);
  await writeBackup(list(entries), PASSWORD, createWriteStream(out), KDF);
  return out;
}

const extract = (sealed: string, password = PASSWORD, into = path.join(dir, "out")) =>
  extractBackup(createReadStream(sealed), password, into);

async function mutate(sealed: string, change: (bytes: Buffer) => Buffer): Promise<string> {
  const changed = path.join(dir, "changed.dozo");
  await writeFile(changed, change(await readFile(sealed)));
  return changed;
}

// Random bytes do not compress: the sealed body spans several 64 KiB chunks.
const big = randomBytes(300 * 1024);

describe("local backup file", () => {
  it("restores files, folders and owner modes exactly", async () => {
    const sealed = await seal([
      file("backup.json", Buffer.from("{}")),
      { path: "data", kind: "dir" },
      { path: "data/empty", kind: "dir" },
      file("data/big.bin", big),
      file("data/tool", Buffer.from("#!/bin/sh\n"), 0o755),
      file("secrets", Buffer.from("ENCRYPTION_KEY=abc\n"), 0o644),
    ]);
    expect((await readFile(sealed)).includes(Buffer.from("ENCRYPTION_KEY"))).toBe(false);
    const written = await extract(sealed);
    expect(written).toEqual(["backup.json", "data/big.bin", "data/tool", "secrets"]);
    const out = path.join(dir, "out");
    expect((await readFile(path.join(out, "data/big.bin"))).equals(big)).toBe(true);
    expect(await readFile(path.join(out, "secrets"), "utf8")).toBe("ENCRYPTION_KEY=abc\n");
    expect(await readdir(path.join(out, "data/empty"))).toEqual([]);
    expect((await stat(path.join(out, "secrets"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(out, "data/tool"))).mode & 0o777).toBe(0o700);
  });

  it("round-trips an empty archive and a body of exactly one chunk", async () => {
    await extract(await seal([], "empty.dozo"), PASSWORD, path.join(dir, "a"));
    // Stored compressed: a 64 KiB body needs bytes that gzip cannot shrink much.
    const sealed = await seal([file("x", randomBytes(64 * 1024 - 200))], "one.dozo");
    expect(await extract(sealed, PASSWORD, path.join(dir, "b"))).toEqual(["x"]);
  });

  it("says the password is wrong", async () => {
    const sealed = await seal([file("x", big)]);
    await expect(extract(sealed, "another password")).rejects.toMatchObject({
      reason: "wrong-password",
    });
  });

  it("refuses a changed byte in a later chunk", async () => {
    const sealed = await seal([file("x", big)]);
    const changed = await mutate(sealed, (bytes) => {
      bytes.writeUInt8(bytes.readUInt8(28 + 64 * 1024 + 16 + 100) ^ 1, 28 + 64 * 1024 + 16 + 100);
      return bytes;
    });
    await expect(extract(changed)).rejects.toMatchObject({ reason: "damaged" });
  });

  it("refuses a file cut off at a chunk boundary or with bytes added", async () => {
    // The seal alone, without the archive's own end mark: 192 KiB of plaintext is three full
    // chunks, so a cut after any of them leaves whole, authentic chunks.
    const plain = randomBytes(3 * 64 * 1024);
    const sealed = path.join(dir, "plain.dozo");
    await pipeline(Readable.from([plain]), await sealer(PASSWORD, KDF), createWriteStream(sealed));
    const open = async (file: string) => {
      const parts: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _encoding, done) {
          parts.push(chunk);
          done();
        },
      });
      await pipeline(createReadStream(file), opener(PASSWORD), sink);
      return Buffer.concat(parts);
    };
    expect((await open(sealed)).equals(plain)).toBe(true);
    const cut = (chunks: number) =>
      mutate(sealed, (bytes) => bytes.subarray(0, 28 + chunks * (64 * 1024 + 16)));
    await expect(open(await cut(2))).rejects.toMatchObject({ reason: "damaged" });
    // Only the first chunk is left: it cannot tell this from a wrong password, and says both.
    await expect(open(await cut(1))).rejects.toThrow("or the file was changed");
    const longer = await mutate(sealed, (bytes) => Buffer.concat([bytes, randomBytes(40)]));
    await expect(open(longer)).rejects.toMatchObject({ reason: "damaged" });
    const archived = await seal([file("x", big)]);
    const cutArchive = await mutate(archived, (bytes) =>
      bytes.subarray(0, 28 + 2 * (64 * 1024 + 16)),
    );
    await expect(extract(cutArchive)).rejects.toMatchObject({ reason: "damaged" });
  });

  it("binds the header: a changed salt or cost does not open", async () => {
    const sealed = await seal([file("x", Buffer.from("hello"))]);
    const salt = await mutate(sealed, (bytes) => {
      bytes.writeUInt8(bytes.readUInt8(20) ^ 1, 20);
      return bytes;
    });
    await expect(extract(salt, PASSWORD, path.join(dir, "a"))).rejects.toMatchObject({
      reason: "wrong-password",
    });
    const huge = await mutate(sealed, (bytes) => {
      bytes[9] = 30;
      return bytes;
    });
    await expect(extract(huge, PASSWORD, path.join(dir, "b"))).rejects.toMatchObject({
      reason: "damaged",
    });
  });

  it("refuses a file that is not a backup or from a newer format", async () => {
    const other = path.join(dir, "other.zip");
    await writeFile(other, randomBytes(200));
    await expect(extract(other, PASSWORD, path.join(dir, "a"))).rejects.toMatchObject({
      reason: "not-a-backup",
    });
    const sealed = await seal([file("x", Buffer.from("hello"))]);
    const newer = await mutate(sealed, (bytes) => {
      bytes[8] = 2;
      return bytes;
    });
    await expect(extract(newer, PASSWORD, path.join(dir, "b"))).rejects.toMatchObject({
      reason: "not-a-backup",
    });
  });

  it("never writes outside the folder", async () => {
    for (const bad of ["../escape", "/etc/x", "a/../../b", "a//b", "a\\b", "./a", ""]) {
      expect(() => safeEntryPath(bad)).toThrow();
      const sealed = await seal([file(bad, Buffer.from("x"))], "bad.dozo");
      await expect(extract(sealed, PASSWORD, path.join(dir, "out", "inner"))).rejects.toMatchObject(
        { reason: "damaged" },
      );
      await rm(sealed);
    }
    expect((await readdir(dir)).filter((name) => name !== "out")).toEqual([]);
    expect(safeEntryPath("data/a.b/c")).toBe("data/a.b/c");
  });

  it("stops where the caller says, before reading the rest", async () => {
    const sealed = await seal([file("backup.json", Buffer.from("{}")), file("x", big)]);
    const seen: string[] = [];
    const stop = new Error("newer");
    await expect(
      extractBackup(createReadStream(sealed), PASSWORD, path.join(dir, "out"), async (name) => {
        seen.push(name);
        throw stop;
      }),
    ).rejects.toBe(stop);
    expect(seen).toEqual(["backup.json"]);
    expect(await readdir(path.join(dir, "out"))).toEqual(["backup.json"]);
  });

  it("fails a backup when a file changes size while it is read", async () => {
    const out = path.join(dir, "grew.dozo");
    const entry: BackupEntry = {
      path: "x",
      kind: "file",
      size: 3,
      mode: 0o600,
      open: () => Readable.from([Buffer.from("four")]),
    };
    await expect(writeBackup(list([entry]), PASSWORD, createWriteStream(out), KDF)).rejects.toThrow(
      "grew",
    );
  });
});

/** A sealed file around archive bytes the writer would never make. */
async function sealRaw(plain: Buffer): Promise<string> {
  const out = path.join(dir, `raw-${randomBytes(4).toString("hex")}.dozo`);
  await pipeline(
    Readable.from([plain]),
    createGzip(),
    await sealer(PASSWORD, KDF),
    createWriteStream(out),
  );
  return out;
}

function head(json: string): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(Buffer.byteLength(json));
  return Buffer.concat([length, Buffer.from(json)]);
}

describe("local backup archive inside the seal", () => {
  const end = Buffer.alloc(4);

  it("refuses entry headers the writer never makes", async () => {
    const bad = [
      head("{not json"),
      head('{"path":"x","kind":"link"}'),
      head('{"path":"x","kind":"file","size":-1,"mode":384}'),
      head('{"path":"x","kind":"file","size":1,"mode":"rw"}'),
      Buffer.from([0, 1, 0, 1]),
      Buffer.concat([head('{"path":"x","kind":"file","size":5,"mode":384}'), Buffer.from("ab")]),
      Buffer.concat([end, Buffer.from("after the end")]),
    ];
    for (const [index, plain] of bad.entries()) {
      const sealed = await sealRaw(plain);
      await expect(
        extract(sealed, PASSWORD, path.join(dir, `out-${index}`)),
        String(index),
      ).rejects.toMatchObject({ reason: "damaged" });
    }
  });

  it("refuses an empty file and a body that is not gzip", async () => {
    const empty = path.join(dir, "empty.dozo");
    await writeFile(empty, "");
    await expect(extract(empty)).rejects.toMatchObject({ reason: "not-a-backup" });
    const out = path.join(dir, "plain.dozo");
    await pipeline(
      Readable.from([randomBytes(100)]),
      await sealer(PASSWORD, KDF),
      createWriteStream(out),
    );
    await expect(extract(out, PASSWORD, path.join(dir, "b"))).rejects.toMatchObject({
      reason: "damaged",
    });
  });
});
