import type { ComputerSize, ComputerSizeSpec } from "@rakazo/contracts";
import { ComputerSizeSchema } from "@rakazo/contracts";

/** Docker refuses a memory limit under 6 MiB; a computer that small could not start anyway. */
const MIN_MEMORY_GB = 0.25;

/**
 * What each computer size gives on a server that runs computers on its own host, from
 * RAKAZO_COMPUTER_SIZES: `size=vCPUs:GB` entries separated by commas (`large=2:2,xlarge=4:4`).
 * A size left out keeps the host's one ceiling for every computer. This is the one source for what
 * a computer is started with and for what Billing shows, so the two cannot differ.
 */
export function operatorComputerSizes(
  raw = process.env.RAKAZO_COMPUTER_SIZES,
): Partial<Record<ComputerSize, ComputerSizeSpec>> {
  const sizes: Partial<Record<ComputerSize, ComputerSizeSpec>> = {};
  for (const entry of (raw ?? "").split(",")) {
    if (!entry.trim()) continue;
    const match = /^\s*(\w+)\s*=\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(entry);
    const size = ComputerSizeSchema.safeParse(match?.[1]).data;
    const vcpus = Number(match?.[2]);
    const memoryGb = Number(match?.[3]);
    if (!size || size in sizes || !(vcpus > 0) || !(memoryGb >= MIN_MEMORY_GB)) {
      throw new Error(
        `RAKAZO_COMPUTER_SIZES must list each size once as size=vCPUs:GB (large=2:2,xlarge=4:4) with at least ${MIN_MEMORY_GB} GB, received "${entry.trim()}"`,
      );
    }
    sizes[size] = { vcpus, memoryGb };
  }
  return sizes;
}

/** The capability a provider declares when it starts computers at the operator's sizes. */
export function operatorComputerSize(size: ComputerSize): ComputerSizeSpec | undefined {
  return operatorComputerSizes()[size];
}
