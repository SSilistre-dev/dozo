import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { NOTICES_FILE, shipsNotices } from "./dozo-notices.js";

it("says notices ship only where the server's folder holds the file", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "dozo-notices-"));
  try {
    expect(shipsNotices(folder)).toBe(false);
    await writeFile(path.join(folder, NOTICES_FILE), "notices");
    expect(shipsNotices(folder)).toBe(true);
    // A hosted server runs from its own folder, which has none.
    expect(shipsNotices()).toBe(false);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
