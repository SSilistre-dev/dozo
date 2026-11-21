import { beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  created: [] as unknown[],
  written: [] as string[],
  deleted: 0,
  writeFails: false,
  dirs: [] as { exists: boolean; create: ReturnType<typeof vi.fn> }[],
  dirExists: false,
}));
const sharing = vi.hoisted(() => ({
  available: true,
  fails: false,
  shared: [] as unknown[],
}));

vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache" },
  Directory: class {
    create = vi.fn();
    exists = files.dirExists;
    constructor() {
      files.dirs.push(this);
    }
  },
  File: class {
    uri = "file:///cache/table-shares/table.csv";
    create(options: unknown) {
      files.created.push(options);
    }
    write(text: string) {
      if (files.writeFails) throw new Error("disk full");
      files.written.push(text);
    }
    delete() {
      files.deleted++;
    }
  },
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: async () => sharing.available,
  shareAsync: async (...args: unknown[]) => {
    sharing.shared.push(args);
    if (sharing.fails) throw new Error("cancelled");
  },
}));

import { shareCsv } from "./dozo-table-share";

beforeEach(() => {
  files.created.length = 0;
  files.written.length = 0;
  files.deleted = 0;
  files.writeFails = false;
  sharing.fails = false;
  files.dirs.length = 0;
  files.dirExists = false;
  sharing.available = true;
  sharing.shared.length = 0;
});

it("writes the CSV with a BOM and opens the share sheet for it", async () => {
  await shareCsv("a,b\n1,2");
  expect(files.dirs[0]?.create).toHaveBeenCalledWith({ intermediates: true });
  expect(files.created).toEqual([{ overwrite: true }]);
  expect(files.written).toEqual(["\uFEFFa,b\n1,2"]);
  expect(sharing.shared).toEqual([
    [
      "file:///cache/table-shares/table.csv",
      { mimeType: "text/csv", UTI: "public.comma-separated-values-text" },
    ],
  ]);
  // The table does not stay in the cache once the sheet has closed.
  expect(files.deleted).toBe(1);
});

it("removes the file when sharing fails or the file cannot be written", async () => {
  sharing.fails = true;
  await expect(shareCsv("a")).rejects.toThrow("cancelled");
  expect(files.deleted).toBe(1);
  files.writeFails = true;
  await expect(shareCsv("a")).rejects.toThrow("disk full");
  expect(files.deleted).toBe(2);
});

it("reuses the folder, and shares nothing where sharing is not available", async () => {
  files.dirExists = true;
  sharing.available = false;
  await shareCsv("a");
  expect(files.dirs[0]?.create).not.toHaveBeenCalled();
  expect(files.written).toEqual(["\uFEFFa"]);
  expect(sharing.shared).toEqual([]);
  expect(files.deleted).toBe(1);
});
