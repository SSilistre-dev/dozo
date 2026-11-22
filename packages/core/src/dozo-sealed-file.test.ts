import { randomBytes, scrypt } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { SealedDeriveKey, SealedKdf } from "./dozo-sealed-file.js";
import {
  encodeSealedEntryHead,
  openOneFile,
  openStream,
  parseSealedEntryHead,
  readSealedHeader,
  SEALED_ACCOUNT_ENTRY,
  SEALED_CHUNK_BYTES,
  SEALED_HEADER_BYTES,
  SEALED_TAG_BYTES,
  SealedFileError,
  sealedEntryPath,
  sealedNonce,
  sealOneFile,
  sealStream,
  writeSealedHeader,
} from "./dozo-sealed-file.js";

// The smallest cost the reader accepts, to keep the tests fast.
const KDF: SealedKdf = { logN: 15, r: 8, p: 1 };
const PASSWORD = "correct horse battery";
const LIMIT = { path: SEALED_ACCOUNT_ENTRY, maxSize: 4 * 1024 ** 3 };
const CHUNK = SEALED_CHUNK_BYTES + SEALED_TAG_BYTES;

const nodeScrypt: SealedDeriveKey = (password, salt, kdf) =>
  new Promise((resolve, reject) => {
    const N = 2 ** kdf.logN;
    scrypt(password, salt, 32, { N, r: kdf.r, p: kdf.p, maxmem: 256 * N * kdf.r }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });

function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

const seal = (plain: Uint8Array, kdf = KDF, password = PASSWORD) =>
  bytesOf(streamOf(plain).pipeThrough(sealStream(password, nodeScrypt, kdf)));

const open = (sealed: Uint8Array, password = PASSWORD, deriveKey = nodeScrypt) =>
  bytesOf(streamOf(sealed).pipeThrough(openStream(password, deriveKey)));

const sealFile = (body: Uint8Array, path = SEALED_ACCOUNT_ENTRY) =>
  bytesOf(
    sealOneFile(
      { path, size: body.length, mode: 0o600 },
      streamOf(body),
      PASSWORD,
      nodeScrypt,
      KDF,
    ),
  );

async function openFile(sealed: Uint8Array, password = PASSWORD, source = streamOf(sealed)) {
  const parts: Uint8Array[] = [];
  for await (const part of openOneFile(source, password, nodeScrypt, LIMIT)) parts.push(part);
  return Buffer.concat(parts);
}

/** A sealed file whose plaintext is gzip of exactly these archive bytes. */
const sealArchive = (...parts: Uint8Array[]) => seal(gzipSync(Buffer.concat(parts)));
const entry = (json: string) => {
  const bytes = Buffer.alloc(4 + Buffer.byteLength(json));
  bytes.writeUInt32BE(Buffer.byteLength(json));
  bytes.write(json, 4);
  return bytes;
};
const END = new Uint8Array(4);
const REFUSED = { reason: "wrong-password", message: "Wrong password, or the file was changed." };

async function failure(work: Promise<unknown>): Promise<SealedFileError> {
  const error = await work.then(
    () => {
      throw new Error("expected a failure");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SealedFileError);
  // One answer for every way an open fails: nothing tells a wrong guess from a changed file.
  expect(error).toMatchObject(REFUSED);
  expect(String((error as Error).message)).not.toContain(PASSWORD);
  expect(JSON.stringify(error)).not.toContain(PASSWORD);
  return error as SealedFileError;
}

describe("sealed stream", () => {
  it("round-trips empty, one byte, exactly one chunk, one more and several chunks", async () => {
    for (const size of [0, 1, SEALED_CHUNK_BYTES, SEALED_CHUNK_BYTES + 1, 300 * 1024]) {
      const plain = randomBytes(size);
      const sealed = await seal(plain);
      const chunks = Math.max(1, Math.ceil(size / SEALED_CHUNK_BYTES));
      expect(sealed.length, String(size)).toBe(
        SEALED_HEADER_BYTES + size + chunks * SEALED_TAG_BYTES,
      );
      expect((await open(sealed)).equals(plain), String(size)).toBe(true);
    }
  });

  it("writes the header and nonce the format defines", async () => {
    const sealed = await seal(new Uint8Array(0), { logN: 16, r: 8, p: 1 });
    expect(sealed.subarray(0, 12)).toEqual(Buffer.from([...Buffer.from("DOZOBAK\n"), 1, 16, 8, 1]));
    expect([...sealedNonce(258n, true)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1]);
    expect([...sealedNonce(0n, false)]).toEqual(new Array(12).fill(0));
    const header = writeSealedHeader({ logN: 15, r: 8, p: 1 }, new Uint8Array(16).fill(7));
    expect(readSealedHeader(header)).toEqual({ kdf: KDF, salt: new Uint8Array(16).fill(7) });
  });

  it("opens fed a byte at a time, and normalizes the password", async () => {
    const plain = randomBytes(SEALED_CHUNK_BYTES * 2 + 5);
    const sealed = await seal(plain, KDF, "caf\u00e9-password");
    let at = 0;
    const byteByByte = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at === sealed.length) controller.close();
        else controller.enqueue(sealed.subarray(at, ++at));
      },
    });
    // The same password typed with a combining accent.
    const opened = await bytesOf(
      byteByByte.pipeThrough(openStream("cafe\u0301-password", nodeScrypt)),
    );
    expect(opened.equals(plain)).toBe(true);
  });

  it("checks the header before deriving any key", async () => {
    const sealed = await seal(randomBytes(10));
    const derive = vi.fn(nodeScrypt);
    // The reasons the local server's reader names; the web open says only `REFUSED`.
    const cases: [number, number, string][] = [
      [0, 0x41, "not-a-backup"],
      [8, 2, "not-a-backup"],
      [9, 14, "damaged"],
      [9, 19, "damaged"],
      [10, 4, "damaged"],
      [11, 2, "damaged"],
    ];
    for (const [at, value, reason] of cases) {
      const changed = Buffer.from(sealed);
      changed[at] = value;
      expect(() => readSealedHeader(changed), `${at}=${value}`).toThrow(
        expect.objectContaining({ reason }),
      );
      await failure(open(changed, PASSWORD, derive));
    }
    expect(derive).not.toHaveBeenCalled();
    await failure(open(sealed.subarray(0, 0)));
    await failure(open(sealed.subarray(0, 20)));
    expect(derive).not.toHaveBeenCalled();
    expect(() => readSealedHeader(new Uint8Array(4))).toThrow(SealedFileError);
  });

  it("answers a wrong password and a change anywhere alike", async () => {
    const sealed = await seal(randomBytes(300 * 1024));
    expect((await failure(open(sealed, "another password"))).reason).toBe("wrong-password");
    for (const at of [12, 20, SEALED_HEADER_BYTES + 3]) {
      const changed = Buffer.from(sealed);
      changed[at] = (changed[at] as number) ^ 1;
      expect((await failure(open(changed))).reason, String(at)).toBe("wrong-password");
    }
    const later = Buffer.from(sealed);
    const at = SEALED_HEADER_BYTES + 2 * CHUNK + 9;
    later[at] = (later[at] as number) ^ 1;
    await failure(open(later));
  });

  it("refuses a file cut off, with a chunk dropped or reordered, or with bytes added", async () => {
    const sealed = await seal(randomBytes(300 * 1024));
    const body = sealed.subarray(SEALED_HEADER_BYTES);
    const header = sealed.subarray(0, SEALED_HEADER_BYTES);
    const chunk = (index: number) => body.subarray(index * CHUNK, (index + 1) * CHUNK);
    const changed = [
      sealed.subarray(0, SEALED_HEADER_BYTES),
      sealed.subarray(0, SEALED_HEADER_BYTES + 8),
      sealed.subarray(0, SEALED_HEADER_BYTES + CHUNK + 100),
      sealed.subarray(0, SEALED_HEADER_BYTES + 4 * CHUNK),
      Buffer.concat([sealed, Buffer.from([0])]),
      Buffer.concat([sealed, randomBytes(CHUNK)]),
      Buffer.concat([header, chunk(0), chunk(2), chunk(1), body.subarray(3 * CHUNK)]),
    ];
    for (const [index, bytes] of changed.entries()) {
      await failure(open(bytes)).catch((error) => {
        throw new Error(`case ${index}: ${error}`);
      });
    }
  });
});

describe("one sealed file", () => {
  it("round-trips the account export, empty and spanning chunks, through gzip", async () => {
    for (const body of [Buffer.alloc(0), Buffer.from("zip"), randomBytes(200 * 1024)]) {
      const opened = await openFile(await sealFile(body));
      expect(opened.equals(body), String(body.length)).toBe(true);
    }
  });

  it("fails a body that is not the size it claims", async () => {
    const write = (size: number, body: Uint8Array) =>
      bytesOf(
        sealOneFile({ path: "a", size, mode: 0o600 }, streamOf(body), PASSWORD, nodeScrypt, KDF),
      );
    await expect(write(2, Buffer.from("abc"))).rejects.toThrow("grew");
    await expect(write(5, Buffer.from("abc"))).rejects.toThrow("shrank");
  });

  it("refuses every archive the writer never makes", async () => {
    const file = (size: number, path = SEALED_ACCOUNT_ENTRY) =>
      entry(JSON.stringify({ path, kind: "file", size, mode: 384 }));
    const bad = [
      [END],
      [entry("x".repeat(64 * 1024 + 1))],
      [Buffer.from([0, 1, 0, 0])],
      [entry("{not json"), END],
      [entry(JSON.stringify({ path: SEALED_ACCOUNT_ENTRY, kind: "dir" })), END],
      [file(2, "backup.json"), Buffer.from("{}"), END],
      [file(2, "../account-export.zip"), Buffer.from("ab"), END],
      [file(5 * 1024 ** 3), END],
      [file(5), Buffer.from("ab")],
      [file(2), Buffer.from("ab")],
      [file(2), Buffer.from("ab"), file(1, "second"), Buffer.from("c"), END],
      [file(2), Buffer.from("ab"), END, Buffer.from("after the end")],
    ];
    for (const [index, parts] of bad.entries()) {
      await failure(openFile(await sealArchive(...parts))).catch((error) => {
        throw new Error(`case ${index}: ${error}`);
      });
    }
    await failure(openFile(await seal(randomBytes(100))));
  });

  it("says a wrong password through the whole open", async () => {
    const sealed = await sealFile(Buffer.from("zip"));
    await failure(openFile(sealed, "another password"));
  });

  it("stops reading an inflated body past the size its entry claims", async () => {
    // About 1 MiB of sealed file inflates to 1 GiB of zeros after a 10-byte entry.
    const zeros = new Uint8Array(1024 * 1024);
    const gzip = new CompressionStream("gzip");
    const writer = gzip.writable.getWriter();
    const plain = (async () => {
      await writer.write(
        Buffer.concat([
          entry(JSON.stringify({ path: SEALED_ACCOUNT_ENTRY, kind: "file", size: 10, mode: 384 })),
          Buffer.alloc(10),
        ]),
      );
      for (let index = 0; index < 1024; index++) await writer.write(zeros);
      await writer.close();
    })();
    const sealed = await bytesOf(gzip.readable.pipeThrough(sealStream(PASSWORD, nodeScrypt, KDF)));
    await plain;
    let pulled = 0;
    let at = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= sealed.length) return controller.close();
        const part = sealed.subarray(at, at + CHUNK);
        at += part.length;
        pulled += part.length;
        controller.enqueue(part);
      },
    });
    await failure(openFile(sealed, PASSWORD, source));
    expect(pulled).toBeLessThan(sealed.length / 2);
  });
});

describe("one answer for every failed open", () => {
  it("gives every failure the same reason and the same message", async () => {
    const sealed = await sealFile(randomBytes(200 * 1024));
    const flip = (at: number) => {
      const changed = Buffer.from(sealed);
      changed[at] = (changed[at] as number) ^ 1;
      return changed;
    };
    const set = (at: number, value: number) => {
      const changed = Buffer.from(sealed);
      changed[at] = value;
      return changed;
    };
    const file = (size: number, path = SEALED_ACCOUNT_ENTRY) =>
      entry(JSON.stringify({ path, kind: "file", size, mode: 384 }));
    const bomb = Buffer.concat([file(2), Buffer.from("ab"), END, Buffer.alloc(8 * 1024 ** 2)]);
    const notGzip = await seal(randomBytes(100));
    const extra = await sealArchive(file(1), Buffer.from("a"), file(1, "b"), Buffer.from("b"), END);
    const inflated = await sealArchive(bomb);
    const cases: [string, () => Promise<unknown>][] = [
      ["wrong password", () => openFile(sealed, "another password")],
      ["first chunk changed", () => openFile(flip(SEALED_HEADER_BYTES + 5))],
      ["later chunk changed", () => openFile(flip(SEALED_HEADER_BYTES + CHUNK + 5))],
      ["cut short", () => openFile(sealed.subarray(0, sealed.length - 100))],
      ["last chunk dropped", () => openFile(sealed.subarray(0, SEALED_HEADER_BYTES + CHUNK))],
      ["bad magic", () => openFile(set(0, 0x41))],
      ["unknown version", () => openFile(set(8, 2))],
      ["cost out of bounds", () => openFile(set(9, 19))],
      ["not gzip", () => openFile(notGzip)],
      ["extra entry", () => openFile(extra)],
      ["inflated past its entry", () => openFile(inflated)],
    ];
    const seen = new Set<string>();
    for (const [name, work] of cases) {
      const error = await failure(work()).catch((cause) => {
        throw new Error(`${name}: ${cause}`);
      });
      seen.add(JSON.stringify([error.reason, error.message, error.constructor.name]));
    }
    expect([...seen]).toEqual([
      JSON.stringify([REFUSED.reason, REFUSED.message, "SealedFileError"]),
    ]);
  });
});

describe("entry heads", () => {
  it("writes and reads a file's and a folder's head, keeping only the owner's bits", () => {
    const file = encodeSealedEntryHead({ path: "a/b", kind: "file", size: 3, mode: 0o4755 });
    expect(new DataView(file.buffer).getUint32(0)).toBe(file.length - 4);
    expect(parseSealedEntryHead(file.subarray(4))).toEqual({
      path: "a/b",
      kind: "file",
      size: 3,
      mode: 0o700,
    });
    const dir = encodeSealedEntryHead({ path: "a", kind: "dir" });
    expect(parseSealedEntryHead(dir.subarray(4))).toEqual({
      path: "a",
      kind: "dir",
      size: 0,
      mode: 0o700,
    });
  });

  it("refuses heads and paths the writer never makes", () => {
    const heads = [
      "null",
      '{"path":"x","kind":"link"}',
      '{"path":"x","kind":"file","size":-1,"mode":384}',
      '{"path":"x","kind":"file","size":1,"mode":"rw"}',
    ];
    for (const head of heads) {
      expect(() => parseSealedEntryHead(Buffer.from(head)), head).toThrow(SealedFileError);
    }
    expect(() => parseSealedEntryHead(Buffer.from([0x7b, 0xff, 0x7d]))).toThrow(SealedFileError);
    for (const path of [1, "", "/a", "a\\b", "a\0", "a//b", "./a", "a/..", "x".repeat(4097)]) {
      expect(() => sealedEntryPath(path), String(path)).toThrow(SealedFileError);
    }
    expect(sealedEntryPath("data/a.txt")).toBe("data/a.txt");
  });
});
