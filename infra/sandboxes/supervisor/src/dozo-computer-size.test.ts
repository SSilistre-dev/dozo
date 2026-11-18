import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { computerSizeFields, resizeStoppedComputer, sizeLimits } from "./dozo-computer-size.js";

const GB = 1024 ** 3;
const large = { NanoCpus: 2e9, Memory: 2 * GB, MemorySwap: 2 * GB };
const xlarge = { NanoCpus: 4e9, Memory: 4 * GB, MemorySwap: 4 * GB };

describe("sizeLimits", () => {
  it("turns vCPUs and GB into Docker's limits, with swap capped at memory", () => {
    expect(sizeLimits({ vcpus: 2, memoryGb: 2 })).toEqual(large);
    expect(sizeLimits({ vcpus: 1.5, memoryGb: 1.5 })).toEqual({
      NanoCpus: 1.5e9,
      Memory: 1.5 * GB,
      MemorySwap: 1.5 * GB,
    });
  });

  it("sets no limit for a start that names no size", () => {
    expect(sizeLimits(undefined)).toEqual({});
  });
});

describe("resizeStoppedComputer", () => {
  it("shrinks a computer to the smaller plan's size on its next start", async () => {
    const update = vi.fn(async () => undefined);
    await resizeStoppedComputer({ update }, xlarge, { vcpus: 2, memoryGb: 2 });
    expect(update).toHaveBeenCalledExactlyOnceWith(large);
  });

  it("grows a computer made under the host's one ceiling to the plan's size", async () => {
    const update = vi.fn(async () => undefined);
    await resizeStoppedComputer(
      { update },
      { NanoCpus: 2e9, Memory: 1536 * 1024 ** 2, MemorySwap: 1536 * 1024 ** 2 },
      { vcpus: 4, memoryGb: 4 },
    );
    expect(update).toHaveBeenCalledExactlyOnceWith(xlarge);
  });

  it("leaves a computer already at the size, and one whose start names none", async () => {
    const update = vi.fn(async () => undefined);
    await resizeStoppedComputer({ update }, large, { vcpus: 2, memoryGb: 2 });
    await resizeStoppedComputer({ update }, xlarge, undefined);
    expect(update).not.toHaveBeenCalled();
  });

  it("fails the start when Docker refuses the size", async () => {
    const update = vi.fn(async () => {
      throw new Error("Range of CPUs is from 0.01 to 2.00");
    });
    await expect(
      resizeStoppedComputer({ update }, large, { vcpus: 64, memoryGb: 2 }),
    ).rejects.toThrow("Range of CPUs");
  });
});

describe("computerSizeFields", () => {
  const body = z.object(computerSizeFields);
  it("accepts a size or none, and refuses one Docker could not apply", () => {
    expect(body.parse({ size: { vcpus: 2, memoryGb: 2 } }).size).toEqual({ vcpus: 2, memoryGb: 2 });
    expect(body.parse({}).size).toBeUndefined();
    expect(() => body.parse({ size: { vcpus: 0, memoryGb: 2 } })).toThrow();
    expect(() => body.parse({ size: { vcpus: 2, memoryGb: 0 } })).toThrow();
    expect(() => body.parse({ size: "large" })).toThrow();
  });
});
