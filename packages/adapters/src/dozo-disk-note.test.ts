import { describe, expect, it } from "vitest";
import { diskNoteInstruction } from "./computer-disk.js";

const disk = (usedGb: number, freeGb: number) => ({
  diskUsedBytes: BigInt(Math.round(usedGb * 1e9)),
  diskFreeBytes: BigInt(Math.round(freeGb * 1e9)),
});

describe("disk note in the system prompt", () => {
  it("keeps the same words while the disk fills a little, so the cached prefix survives", () => {
    const notes = [0, 0.2, 0.4].map((i) => diskNoteInstruction(disk(35.2 + i, 4.8 - i)));
    expect(new Set(notes).size).toBe(1);
    expect(notes[0]).toBe(
      "The computer's disk is over 85% full (about 4 GB free). Free space by removing build output and caches you no longer need, or tell the user.",
    );
  });

  it("rounds down to steps of 5 percent and to the leading digit of what is free", () => {
    expect(diskNoteInstruction(disk(91, 9))).toContain("over 90% full (about 9 GB free)");
    expect(diskNoteInstruction(disk(180, 19.9))).toContain("(about 10 GB free)");
    expect(diskNoteInstruction(disk(9.5, 0.47))).toContain("over 95% full (about 400 MB free)");
    expect(diskNoteInstruction(disk(10, 0))).toContain("over 100% full (about 1 MB free)");
    expect(diskNoteInstruction(disk(80, 20))).toBeUndefined();
  });
});
