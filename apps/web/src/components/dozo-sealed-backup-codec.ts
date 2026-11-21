import { scryptAsync } from "@noble/hashes/scrypt.js";
import type { SealedDeriveKey, SealedKdf } from "@rakazo/core";
import {
  openOneFile,
  SEALED_ACCOUNT_ENTRY,
  SEALED_ACCOUNT_MAX_BYTES,
  SEALED_DEFAULT_KDF,
  sealOneFile,
} from "@rakazo/core";

/**
 * The account backup sealed in the page: the account export's zip as the one entry of the same
 * file the local server's backup writes (`@rakazo/core`, `dozo-sealed-file.ts`). Loaded only when
 * a backup or restore starts, so neither this nor scrypt weighs on the first paint.
 */

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
  return collect(readAll(sealed));
}

/**
 * The zip inside a sealed account backup, returned only once the whole file has been checked;
 * a wrong password or any other file is a `SealedFileError`. The caller has already refused a
 * file over `SEALED_ACCOUNT_FILE_MAX_BYTES` without reading it.
 */
export async function openAccountBackup(file: Blob, password: string): Promise<Blob> {
  const limit = { path: SEALED_ACCOUNT_ENTRY, maxSize: SEALED_ACCOUNT_MAX_BYTES };
  return collect(openOneFile(file.stream(), password, deriveKey, limit), "application/zip");
}

async function* readAll(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    yield value;
  }
}

/** The parts as one `Blob`, which the browser may keep out of the page's memory. */
async function collect(parts: AsyncIterable<Uint8Array>, type = ""): Promise<Blob> {
  const blobs: BlobPart[] = [];
  for await (const part of parts) blobs.push(part as Uint8Array<ArrayBuffer>);
  return new Blob(blobs, { type });
}
