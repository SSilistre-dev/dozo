import { randomBytes, scryptSync } from "node:crypto";
import type { SealedKdf } from "@rakazo/core";
import { SealedFileError } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import {
  collectBlob,
  deriveKey,
  openAccountBackup,
  sealAccountExport,
} from "./dozo-sealed-backup-codec";

// The smallest cost the reader accepts, to keep the tests fast.
const KDF: SealedKdf = { logN: 15, r: 8, p: 1 };
const PASSWORD = "correct horse battery";

describe("account backup sealed in the page", () => {
  it("derives the same key as Node's scrypt with the format's parameters", async () => {
    const salt = randomBytes(16);
    const expected = scryptSync("pässword".normalize("NFC"), salt, 32, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 ** 2,
    });
    const key = await deriveKey("pässword".normalize("NFC"), salt, KDF);
    expect(Buffer.from(key).equals(expected)).toBe(true);
  });

  it("seals the export's zip and opens it back as a zip", async () => {
    const zip = new Blob([randomBytes(150 * 1024)]);
    const sealed = await sealAccountExport(zip, PASSWORD, KDF);
    expect(new TextDecoder().decode(await sealed.slice(0, 8).arrayBuffer())).toBe("DOZOBAK\n");
    const opened = await openAccountBackup(sealed, PASSWORD);
    expect(opened.type).toBe("application/zip");
    expect(Buffer.from(await opened.arrayBuffer())).toEqual(Buffer.from(await zip.arrayBuffer()));
  });

  it("refuses a wrong password without naming the one tried", async () => {
    const sealed = await sealAccountExport(new Blob(["zip"]), PASSWORD, KDF);
    const error = await openAccountBackup(sealed, "another password").catch((cause) => cause);
    expect(error).toBeInstanceOf(SealedFileError);
    expect(error.message).not.toContain("another password");
  });

  it("folds the parts into one Blob as they come, keeping every byte in order", async () => {
    const parts = Array.from({ length: 10 }, (_, index) => randomBytes(1000 + index));
    async function* source() {
      yield* parts;
    }
    const built: number[] = [];
    const Real = Blob;
    vi.stubGlobal(
      "Blob",
      class extends Real {
        constructor(blobParts?: BlobPart[], options?: BlobPropertyBag) {
          super(blobParts, options);
          built.push(blobParts?.length ?? 0);
        }
      },
    );
    try {
      const blob = await collectBlob(source(), "application/zip", 3000);
      expect(blob.type).toBe("application/zip");
      expect(Buffer.from(await blob.arrayBuffer())).toEqual(Buffer.concat(parts));
      // Three parts reach 3000 bytes: three folds, each holding the last blob and its batch, then the rest.
      expect(built).toEqual([0, 4, 4, 4, 2]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
