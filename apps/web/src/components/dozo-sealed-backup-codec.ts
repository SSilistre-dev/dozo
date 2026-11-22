import { scryptAsync } from "@noble/hashes/scrypt.js";
import type { SealedDeriveKey, SealedKdf } from "@rakazo/core/dozo-sealed-file";
import {
  openOneFile,
  SEALED_ACCOUNT_ENTRY,
  SEALED_ACCOUNT_FILE_MAX_BYTES,
  SEALED_ACCOUNT_MAX_BYTES,
  SEALED_DEFAULT_KDF,
  SealedFileError,
  sealOneFile,
} from "@rakazo/core/dozo-sealed-file";

/**
 * The account backup sealed in the page: the account export's zip as the one entry of the same
 * file the local server's backup writes (`@rakazo/core/dozo-sealed-file`). Loaded only when
 * a backup or restore starts, so neither this nor scrypt weighs on the first paint.
 */

/** The largest account export a restore takes back, and the largest sealed file it opens. */
export const ACCOUNT_EXPORT_MAX_BYTES = SEALED_ACCOUNT_MAX_BYTES;
export const ACCOUNT_BACKUP_MAX_BYTES = SEALED_ACCOUNT_FILE_MAX_BYTES;

/**
 * Whether an open failed because of the file or its password. Asked here so that only this lazy
 * module, never the settings row, references the sealed-file code.
 */
export const isSealedFileError = (error: unknown) => error instanceof SealedFileError;

/**
 * scrypt in the page, yielding every few milliseconds so the page keeps painting. Its default
 * memory cap (1 GiB) is above the most the header may ask for (log2(N) 18: 256 MiB).
 */
export const deriveKey: SealedDeriveKey = (password, salt, kdf) =>
  scryptAsync(password, salt, { N: 2 ** kdf.logN, r: kdf.r, p: kdf.p, dkLen: 32, asyncTick: 10 });

/** The export's zip, sealed with the password. */
export async function sealAccountExport(
  zip: Blob,
  password: string,
  kdf: SealedKdf = SEALED_DEFAULT_KDF,
): Promise<Blob> {
  const file = { path: SEALED_ACCOUNT_ENTRY, size: zip.size, mode: 0o600 };
  const sealed = sealOneFile(file, zip.stream(), password, deriveKey, kdf);
  return collectBlob(readAll(sealed));
}

/**
 * The zip inside a sealed account backup, returned only once the whole file has been checked;
 * a wrong password or any other file is a `SealedFileError`. The caller has already refused a
 * file over `SEALED_ACCOUNT_FILE_MAX_BYTES` without reading it.
 */
export async function openAccountBackup(file: Blob, password: string): Promise<Blob> {
  const limit = { path: SEALED_ACCOUNT_ENTRY, maxSize: SEALED_ACCOUNT_MAX_BYTES };
  return collectBlob(openOneFile(file.stream(), password, deriveKey, limit), "application/zip");
}

/** A body as a `Blob`, or null as soon as it passes `maxBytes`; the rest is never read. */
export async function readUpTo(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Blob | null> {
  if (!body) return new Blob([]);
  try {
    return await collectBlob(readAll(body), "", undefined, maxBytes);
  } catch (error) {
    if (error instanceof OverLimit) return null;
    throw error;
  }
}

class OverLimit extends Error {}

async function* readAll(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      done = next.done;
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // A reader that stopped early (a limit, a failure) cancels the rest of the stream.
    if (!done) await reader.cancel();
  }
}

/**
 * The parts as one `Blob`, folded in every `foldBytes` so the page never holds more than that in
 * its own arrays: the browser may keep a Blob out of the page's memory, an array it cannot.
 */
export async function collectBlob(
  parts: AsyncIterable<Uint8Array>,
  type = "",
  foldBytes = 64 * 1024 ** 2,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Blob> {
  let blob = new Blob([], { type });
  let batch: BlobPart[] = [];
  let held = 0;
  let total = 0;
  for await (const part of parts) {
    total += part.length;
    if (total > maxBytes) throw new OverLimit();
    batch.push(part as Uint8Array<ArrayBuffer>);
    held += part.length;
    if (held < foldBytes) continue;
    blob = new Blob([blob, ...batch], { type });
    batch = [];
    held = 0;
  }
  return new Blob([blob, ...batch], { type });
}
