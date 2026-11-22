import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { TransformCallback } from "node:stream";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { SealedFailure, SealedKdf } from "@rakazo/core/dozo-sealed-file";
import {
  encodeSealedEntryHead,
  parseSealedEntryHead,
  readSealedHeader,
  SEALED_CHUNK_BYTES,
  SEALED_DEFAULT_KDF,
  SEALED_HEADER_BYTES,
  SEALED_MAX_ENTRY_HEADER,
  SEALED_TAG_BYTES,
  SealedFileError,
  sealedDamaged,
  sealedEntryPath,
  sealedNonce,
  writeSealedHeader,
} from "@rakazo/core/dozo-sealed-file";

/**
 * The local backup file, written and read with Node's streams and crypto. The format itself
 * (header, limits, nonce, archive entry heads, failures) is defined once in
 * `@rakazo/core/dozo-sealed-file`, which the account backup made in the browser shares; layout
 * and why each piece was chosen: `dozo/server-bundle/README.md`, "Backup file".
 */

const HEADER_BYTES = SEALED_HEADER_BYTES;
const CHUNK = SEALED_CHUNK_BYTES;
const TAG = SEALED_TAG_BYTES;
const MAX_ENTRY_HEADER = SEALED_MAX_ENTRY_HEADER;
export const DEFAULT_KDF: Kdf = SEALED_DEFAULT_KDF;

export type Kdf = SealedKdf;

export type BackupEntry =
  | { path: string; kind: "dir" }
  | { path: string; kind: "file"; size: number; mode: number; open: () => Readable };

export type BackupFailure = SealedFailure;
export const BackupFormatError = SealedFileError;
export type BackupFormatError = SealedFileError;

const damaged = sealedDamaged;

function deriveKey(password: string, salt: Uint8Array, kdf: Kdf): Promise<Buffer> {
  const N = 2 ** kdf.logN;
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFC"),
      salt,
      32,
      { N, r: kdf.r, p: kdf.p, maxmem: 256 * N * kdf.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

const nonce = sealedNonce;

/** Plaintext in, the sealed file out (header first). */
export async function sealer(password: string, kdf: Kdf = DEFAULT_KDF): Promise<Transform> {
  const salt = randomBytes(16);
  const header = writeSealedHeader(kdf, salt);
  const key = await deriveKey(password, salt, kdf);
  let pending = Buffer.alloc(0);
  let counter = 0n;
  const seal = (stream: Transform, plain: Buffer, last: boolean) => {
    const cipher = createCipheriv("aes-256-gcm", key, nonce(counter++, last));
    cipher.setAAD(header);
    stream.push(Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]));
  };
  return new Transform({
    construct(done) {
      this.push(header);
      done();
    },
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      pending = Buffer.concat([pending, chunk]);
      // A full chunk is sealed only once more follows: the last chunk carries the flag.
      while (pending.length > CHUNK) {
        seal(this, pending.subarray(0, CHUNK), false);
        pending = pending.subarray(CHUNK);
      }
      done();
    },
    flush(done) {
      seal(this, pending, true);
      done();
    },
  });
}

/** The sealed file in, plaintext out; fails on a wrong password or any change to the file. */
export function opener(password: string): Transform {
  let header: Buffer | undefined;
  let key: Buffer | undefined;
  let pending = Buffer.alloc(0);
  let counter = 0n;
  const open = (sealed: Buffer, last: boolean) => {
    if (!key || !header || sealed.length < TAG) throw damaged();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce(counter, last));
    decipher.setAAD(header);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    const body = decipher.update(sealed.subarray(0, sealed.length - TAG));
    try {
      decipher.final();
    } catch {
      // The first chunk cannot tell a wrong password from a changed file; a later one can.
      throw counter === 0n
        ? new BackupFormatError("wrong-password", "Wrong password, or the file was changed.")
        : damaged();
    }
    counter++;
    return body;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      pending = Buffer.concat([pending, chunk]);
      const go = async () => {
        if (!header) {
          if (pending.length < HEADER_BYTES) return;
          header = Buffer.from(pending.subarray(0, HEADER_BYTES));
          pending = pending.subarray(HEADER_BYTES);
          const { kdf, salt } = readSealedHeader(header);
          key = await deriveKey(password, salt, kdf);
        }
        while (pending.length > CHUNK + TAG) {
          this.push(open(pending.subarray(0, CHUNK + TAG), false));
          pending = pending.subarray(CHUNK + TAG);
        }
      };
      go().then(() => done(), done);
    },
    flush(done) {
      try {
        if (!header) {
          throw new BackupFormatError("not-a-backup", "This is not a Dozo backup file.");
        }
        this.push(open(pending, true));
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

async function* archive(entries: AsyncIterable<BackupEntry>): AsyncGenerator<Buffer> {
  for await (const entry of entries) {
    const { path: name, kind } = entry;
    yield Buffer.from(encodeSealedEntryHead(entry));
    if (kind !== "file") continue;
    let left = entry.size;
    for await (const chunk of entry.open()) {
      const bytes = chunk as Buffer;
      if (bytes.length > left) throw new Error(`${name} grew while it was backed up`);
      left -= bytes.length;
      yield bytes;
    }
    if (left !== 0) throw new Error(`${name} shrank while it was backed up`);
  }
  yield Buffer.alloc(4);
}

/** Writes the entries, compressed and sealed, to `out`. */
export async function writeBackup(
  entries: AsyncIterable<BackupEntry>,
  password: string,
  out: NodeJS.WritableStream,
  kdf: Kdf = DEFAULT_KDF,
): Promise<void> {
  await pipeline(Readable.from(archive(entries)), createGzip(), await sealer(password, kdf), out);
}

/** Bytes pulled off an async iterator in the sizes the archive asks for. */
class ByteReader {
  #pending = Buffer.alloc(0);
  constructor(private readonly source: AsyncIterator<Buffer>) {}

  async #fill(): Promise<boolean> {
    const { value, done } = await this.source.next();
    if (done) return false;
    this.#pending = Buffer.concat([this.#pending, value]);
    return true;
  }

  async exactly(count: number): Promise<Buffer> {
    while (this.#pending.length < count) if (!(await this.#fill())) throw damaged();
    const bytes = this.#pending.subarray(0, count);
    this.#pending = this.#pending.subarray(count);
    return bytes;
  }

  async *take(count: number): AsyncGenerator<Buffer> {
    let left = count;
    while (left > 0) {
      if (this.#pending.length === 0 && !(await this.#fill())) throw damaged();
      const bytes = this.#pending.subarray(0, left);
      this.#pending = this.#pending.subarray(bytes.length);
      left -= bytes.length;
      yield bytes;
    }
  }

  async atEnd(): Promise<boolean> {
    while (this.#pending.length === 0) if (!(await this.#fill())) return true;
    return false;
  }
}

export const safeEntryPath = sealedEntryPath;
// Owner bits only: the folder is this user's alone, and so is everything restored into it.
const entryHead = parseSealedEntryHead;

/**
 * Opens the sealed file at `input` and writes its entries under `dir`, which should be new and
 * empty. `inspect` runs after each file is written; throwing stops the restore there. The whole
 * file is checked only once this resolves: until then nothing under `dir` is to be trusted.
 */
export async function extractBackup(
  input: NodeJS.ReadableStream,
  password: string,
  dir: string,
  inspect: (entryPath: string) => Promise<void> = async () => {},
): Promise<string[]> {
  const plain = createGunzip();
  // Settles with the first error on the way (the opener's names a wrong password or a change,
  // where gzip after it would only see bad data), or null.
  const flowed = pipeline(input, opener(password), plain).then(
    () => null,
    (error: unknown) => error,
  );
  const written: string[] = [];
  try {
    const reader = new ByteReader(plain[Symbol.asyncIterator]());
    for (;;) {
      const length = (await reader.exactly(4)).readUInt32BE();
      if (length === 0) break;
      if (length > MAX_ENTRY_HEADER) throw damaged();
      const head = entryHead(await reader.exactly(length));
      const target = path.join(dir, ...head.path.split("/"));
      if (head.kind === "dir") {
        await mkdir(target, { recursive: true, mode: 0o700 });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await pipeline(
        Readable.from(reader.take(head.size)),
        createWriteStream(target, { flags: "wx", mode: head.mode }),
      );
      written.push(head.path);
      await inspect(head.path);
    }
    if (!(await reader.atEnd())) throw damaged();
    const failed = await flowed;
    if (failed) throw failed;
  } catch (error) {
    // Stops reading the file and waits for it to close.
    plain.destroy();
    const failed = await flowed;
    if (failed instanceof BackupFormatError) throw failed;
    throw error instanceof BackupFormatError ? error : translate(error);
  }
  return written;
}

function translate(error: unknown): unknown {
  const code = (error as { code?: string }).code;
  return code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR" ? damaged() : error;
}
