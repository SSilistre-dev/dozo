/**
 * The password-sealed backup file, defined once: the local server's backup
 * (`packages/adapters/src/dozo-local-backup-format.ts`, Node streams) and the account backup made
 * in the browser (this file's web codec) write and read the same bytes. Layout, limits and why
 * each piece was chosen: `dozo/server-bundle/README.md`, "Backup file".
 *
 * Header (28 bytes): magic `DOZOBAK\n`, format 1, scrypt log2(N), r, p, 16-byte salt. The key is
 * scrypt(NFC password, salt) and is new for every file. The body is gzip of the archive, cut into
 * 64 KiB chunks, each sealed with AES-256-GCM under the nonce (chunk counter, last-chunk flag)
 * with the header as associated data, so a chunk cannot be reordered, dropped, cut off at the end
 * or moved to another file without the open failing.
 *
 * Archive: entries of a 4-byte big-endian length, a JSON header (`path`, `kind`, `size`, `mode`)
 * and, for a file, its bytes; a zero length ends it.
 *
 * Web APIs only (WebCrypto, compression and WHATWG streams). scrypt is not one of them, so the
 * caller passes it in as `deriveKey`.
 */

export const SEALED_MAGIC = /* @__PURE__ */ Uint8Array.of(68, 79, 90, 79, 66, 65, 75, 10);
export const SEALED_FORMAT = 1;
export const SEALED_HEADER_BYTES = 28;
export const SEALED_CHUNK_BYTES = 64 * 1024;
export const SEALED_TAG_BYTES = 16;
export const SEALED_MAX_ENTRY_HEADER = 64 * 1024;
/** The one entry of an account backup made in the browser: the account export's zip. */
export const SEALED_ACCOUNT_ENTRY = "account-export.zip";
/** The account import's body limit, `ACCOUNT_IMPORT_LIMITS.bodyBytes` in `apps/api/src/account-import.ts`. */
export const SEALED_ACCOUNT_MAX_BYTES = 4 * 1024 ** 3;
/** The largest sealed account backup: the zip and room for the header, tags, gzip and entry head. */
export const SEALED_ACCOUNT_FILE_MAX_BYTES = SEALED_ACCOUNT_MAX_BYTES + 16 * 1024 ** 2;

export type SealedKdf = { logN: number; r: number; p: number };
/** 128 MiB of memory and well under a second: the strength the file is written with. */
export const SEALED_DEFAULT_KDF: SealedKdf = { logN: 17, r: 8, p: 1 };

/** scrypt(password, salt) with the file's parameters, 32 bytes. The password is already NFC. */
export type SealedDeriveKey = (
  password: string,
  salt: Uint8Array,
  kdf: SealedKdf,
) => Promise<Uint8Array>;

export type SealedFailure = "not-a-backup" | "wrong-password" | "damaged";

export class SealedFileError extends Error {
  constructor(
    readonly reason: SealedFailure,
    message: string,
  ) {
    super(message);
  }
}

export const sealedDamaged = () =>
  new SealedFileError("damaged", "The backup file is damaged or incomplete.");
const notABackup = () => new SealedFileError("not-a-backup", "This is not a Dozo backup file.");
/**
 * The web open's one answer to every failure: a wrong password, a changed, cut or foreign file, a
 * cost out of bounds and an archive it never writes all read the same, so a guess learns nothing
 * from how it failed. The local server's Node reader keeps its separate reasons.
 */
const refused = () =>
  new SealedFileError("wrong-password", "Wrong password, or the file was changed.");

/** Runs one step of an open; whatever it fails with becomes the one refusal. */
async function refusing<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch {
    throw refused();
  }
}

export function writeSealedHeader(kdf: SealedKdf, salt: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(SEALED_HEADER_BYTES);
  header.set(SEALED_MAGIC);
  header.set([SEALED_FORMAT, kdf.logN, kdf.r, kdf.p], SEALED_MAGIC.length);
  header.set(salt.subarray(0, 16), SEALED_MAGIC.length + 4);
  return header;
}

/** Checks the header before any key is derived: a crafted cost cannot ask for gigabytes. */
export function readSealedHeader(bytes: Uint8Array): { kdf: SealedKdf; salt: Uint8Array } {
  if (bytes.length < SEALED_HEADER_BYTES || SEALED_MAGIC.some((byte, at) => bytes[at] !== byte)) {
    throw notABackup();
  }
  const [format, logN, r, p] = bytes.subarray(SEALED_MAGIC.length, SEALED_MAGIC.length + 4);
  if (format !== SEALED_FORMAT) {
    throw new SealedFileError(
      "not-a-backup",
      "This backup file is from a newer Dozo. Update Dozo, then restore it.",
    );
  }
  if (logN === undefined || logN < 15 || logN > 18 || r !== 8 || p !== 1) throw sealedDamaged();
  return {
    kdf: { logN, r, p },
    salt: bytes.subarray(SEALED_MAGIC.length + 4, SEALED_HEADER_BYTES),
  };
}

/** The chunk counter as 11 big-endian bytes, then 1 on the last chunk and 0 before it. */
export function sealedNonce(counter: bigint, last: boolean): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(12);
  new DataView(bytes.buffer).setBigUint64(3, counter);
  bytes[11] = last ? 1 : 0;
  return bytes;
}

/** A relative path of plain names: no `..`, `.`, empty part, absolute start or backslash. */
export function sealedEntryPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw sealedDamaged();
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/")) throw sealedDamaged();
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw sealedDamaged();
  }
  return value;
}

export type SealedEntryHead =
  | { path: string; kind: "dir" }
  | { path: string; kind: "file"; size: number; mode: number };

/** An entry's length prefix and JSON header, as the archive holds them. */
export function encodeSealedEntryHead(head: SealedEntryHead): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(
    JSON.stringify(
      head.kind === "file"
        ? { path: head.path, kind: "file", size: head.size, mode: head.mode & 0o777 }
        : { path: head.path, kind: "dir" },
    ),
  );
  const bytes = new Uint8Array(4 + json.length);
  new DataView(bytes.buffer).setUint32(0, json.length);
  bytes.set(json, 4);
  return bytes;
}

/** An entry's JSON header, checked; a file keeps only the owner's bits (0600 or 0700). */
export function parseSealedEntryHead(json: Uint8Array): {
  path: string;
  kind: "dir" | "file";
  size: number;
  mode: number;
} {
  let head: Record<string, unknown>;
  try {
    head = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
  } catch {
    throw sealedDamaged();
  }
  const name = sealedEntryPath(head?.path);
  if (head.kind === "dir") return { path: name, kind: "dir", size: 0, mode: 0o700 };
  const { size, mode } = head;
  if (head.kind !== "file" || !Number.isSafeInteger(size) || (size as number) < 0) {
    throw sealedDamaged();
  }
  if (!Number.isInteger(mode)) throw sealedDamaged();
  return {
    path: name,
    kind: "file",
    size: size as number,
    mode: (mode as number) & 0o100 ? 0o700 : 0o600,
  };
}

/** Bytes queued as they arrive and taken in the sizes asked for, without one growing copy. */
class ByteQueue {
  #parts: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array) {
    if (bytes.length === 0) return;
    this.#parts.push(bytes);
    this.length += bytes.length;
  }

  take(count: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(count);
    let at = 0;
    let used = 0;
    while (at < count) {
      const head = this.#parts[used] as Uint8Array;
      const part = head.subarray(0, count - at);
      out.set(part, at);
      at += part.length;
      if (part.length === head.length) used++;
      else this.#parts[used] = head.subarray(part.length);
    }
    // Once per take, so a stream of tiny pieces costs no more than a few large ones.
    this.#parts.splice(0, used);
    this.length -= count;
    return out;
  }
}

function aesKey(bytes: Uint8Array, use: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(bytes), "AES-GCM", false, [use]);
}

/** Plaintext in, the sealed file out (header first). */
export function sealStream(
  password: string,
  deriveKey: SealedDeriveKey,
  kdf: SealedKdf = SEALED_DEFAULT_KDF,
): TransformStream<Uint8Array, Uint8Array> {
  const pending = new ByteQueue();
  let header = new Uint8Array(0);
  let key: CryptoKey | undefined;
  let counter = 0n;
  const seal = async (plain: Uint8Array<ArrayBuffer>, last: boolean) => {
    const iv = sealedNonce(counter++, last);
    const params = { name: "AES-GCM", iv, additionalData: header };
    return new Uint8Array(await crypto.subtle.encrypt(params, key as CryptoKey, plain));
  };
  return new TransformStream({
    async start(controller) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      header = writeSealedHeader(kdf, salt);
      key = await aesKey(await deriveKey(password.normalize("NFC"), salt, kdf), "encrypt");
      controller.enqueue(header);
    },
    async transform(chunk, controller) {
      pending.push(chunk);
      // A full chunk is sealed only once more follows: the last chunk carries the flag.
      while (pending.length > SEALED_CHUNK_BYTES) {
        controller.enqueue(await seal(pending.take(SEALED_CHUNK_BYTES), false));
      }
    },
    async flush(controller) {
      controller.enqueue(await seal(pending.take(pending.length), true));
    },
  });
}

/**
 * The sealed file in, plaintext out; a wrong password or any change to the file fails it with the
 * one refusal.
 */
export function openStream(
  password: string,
  deriveKey: SealedDeriveKey,
): TransformStream<Uint8Array, Uint8Array> {
  const pending = new ByteQueue();
  let header: Uint8Array<ArrayBuffer> | undefined;
  let key: CryptoKey | undefined;
  let counter = 0n;
  const open = async (sealed: Uint8Array<ArrayBuffer>, last: boolean) => {
    if (!key || !header || sealed.length < SEALED_TAG_BYTES) throw refused();
    const params = { name: "AES-GCM", iv: sealedNonce(counter++, last), additionalData: header };
    return new Uint8Array(await crypto.subtle.decrypt(params, key, sealed));
  };
  return new TransformStream({
    transform: (chunk, controller) =>
      refusing(async () => {
        pending.push(chunk);
        if (!header) {
          if (pending.length < SEALED_HEADER_BYTES) return;
          header = pending.take(SEALED_HEADER_BYTES);
          const { kdf, salt } = readSealedHeader(header);
          key = await aesKey(await deriveKey(password.normalize("NFC"), salt, kdf), "decrypt");
        }
        while (pending.length > SEALED_CHUNK_BYTES + SEALED_TAG_BYTES) {
          const sealed = pending.take(SEALED_CHUNK_BYTES + SEALED_TAG_BYTES);
          controller.enqueue(await open(sealed, false));
        }
      }),
    flush: (controller) =>
      refusing(async () => {
        if (!header) throw refused();
        controller.enqueue(await open(pending.take(pending.length), true));
      }),
  });
}

/** gzip as a byte transform: its types take only ArrayBuffer-backed bytes, which every chunk here is. */
function gzip(stream: CompressionStream | DecompressionStream) {
  return stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
}

function streamOf(source: AsyncIterator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await source.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await source.return?.(reason);
    },
  });
}

async function* oneFileArchive(
  file: { path: string; size: number; mode: number },
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield encodeSealedEntryHead({ kind: "file", ...file });
  const reader = body.getReader();
  let left = file.size;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value.length > left) throw new Error(`${file.path} grew while it was backed up`);
    left -= value.length;
    yield value;
  }
  if (left !== 0) throw new Error(`${file.path} shrank while it was backed up`);
  yield new Uint8Array(4);
}

/** Plaintext pulled off a stream, never more in total than the archive may hold. */
class LimitedReader {
  #queue = new ByteQueue();
  #pulled = 0;
  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    public limit: number,
  ) {}

  async #fill(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done) return false;
    this.#pulled += value.length;
    // An inflated body larger than the entry it claims stops here, not when it runs out.
    if (this.#pulled > this.limit) throw sealedDamaged();
    this.#queue.push(value);
    return true;
  }

  async exactly(count: number): Promise<Uint8Array<ArrayBuffer>> {
    while (this.#queue.length < count) if (!(await this.#fill())) throw sealedDamaged();
    return this.#queue.take(count);
  }

  async length(): Promise<number> {
    return new DataView((await this.exactly(4)).buffer).getUint32(0);
  }

  async *take(count: number): AsyncGenerator<Uint8Array> {
    let left = count;
    while (left > 0) {
      if (this.#queue.length === 0 && !(await this.#fill())) throw sealedDamaged();
      const part = this.#queue.take(Math.min(left, this.#queue.length));
      left -= part.length;
      yield part;
    }
  }

  async atEnd(): Promise<boolean> {
    while (this.#queue.length === 0) if (!(await this.#fill())) return true;
    return false;
  }
}

/**
 * The bytes of the archive's one file entry, which must be `expected.path` and at most
 * `expected.maxSize` bytes, followed by the end marker and nothing else. It returns only once the
 * stream has ended, so only a caller that read to the end has a checked file.
 */
async function* oneFileOf(
  plain: ReadableStream<Uint8Array>,
  expected: { path: string; maxSize: number },
): AsyncGenerator<Uint8Array> {
  const reader = plain.getReader();
  const bytes = new LimitedReader(reader, 8 + SEALED_MAX_ENTRY_HEADER + expected.maxSize);
  let finished = false;
  try {
    const length = await bytes.length();
    if (length === 0 || length > SEALED_MAX_ENTRY_HEADER) throw sealedDamaged();
    const head = parseSealedEntryHead(await bytes.exactly(length));
    if (head.kind !== "file" || head.path !== expected.path || head.size > expected.maxSize) {
      throw sealedDamaged();
    }
    bytes.limit = 8 + length + head.size;
    yield* bytes.take(head.size);
    if ((await bytes.length()) !== 0 || !(await bytes.atEnd())) throw sealedDamaged();
    finished = true;
  } finally {
    // Stops reading the file: a failure, or a caller that gave up, needs none of the rest. On a
    // stream that already failed this rejects with that same failure, which is what is thrown.
    if (!finished) await reader.cancel();
  }
}

/** One file, archived, compressed and sealed: the account backup made in the browser. */
export function sealOneFile(
  file: { path: string; size: number; mode: number },
  body: ReadableStream<Uint8Array>,
  password: string,
  deriveKey: SealedDeriveKey,
  kdf: SealedKdf = SEALED_DEFAULT_KDF,
): ReadableStream<Uint8Array> {
  return streamOf(oneFileArchive(file, body))
    .pipeThrough(gzip(new CompressionStream("gzip")))
    .pipeThrough(sealStream(password, deriveKey, kdf));
}

/**
 * Opens a file `sealOneFile` made and yields its one entry's bytes. Every failure is a
 * `SealedFileError`. The file is checked whole (last chunk, archive end) only when this returns:
 * use nothing it yielded before that.
 */
export async function* openOneFile(
  sealed: ReadableStream<Uint8Array>,
  password: string,
  deriveKey: SealedDeriveKey,
  expected: { path: string; maxSize: number },
): AsyncGenerator<Uint8Array> {
  const plain = sealed
    .pipeThrough(openStream(password, deriveKey))
    .pipeThrough(gzip(new DecompressionStream("gzip")));
  try {
    yield* oneFileOf(plain, expected);
  } catch {
    throw refused();
  }
}
