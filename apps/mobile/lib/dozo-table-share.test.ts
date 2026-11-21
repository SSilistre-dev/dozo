import { beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  created: [] as unknown[],
  written: [] as string[],
  dirs: [] as { exists: boolean; create: ReturnType<typeof vi.fn> }[],
  dirExists: false,
}));
const sharing = vi.hoisted(() => ({
  available: true,
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
      files.written.push(text);
    }
  },
}));
vi.mock("expo-sharing", () => ({
  isAvailableAsync: async () => sharing.available,
  shareAsync: async (...args: unknown[]) => void sharing.shared.push(args),
}));

import { shareCsv } from "./dozo-table-share";

beforeEach(() => {
  files.created.length = 0;
  files.written.length = 0;
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
});

it("reuses the folder, and shares nothing where sharing is not available", async () => {
  files.dirExists = true;
  sharing.available = false;
  await shareCsv("a");
  expect(files.dirs[0]?.create).not.toHaveBeenCalled();
  expect(files.written).toEqual(["\uFEFFa"]);
  expect(sharing.shared).toEqual([]);
});
