import type Docker from "dockerode";
import { z } from "zod";

/**
 * The vCPUs and memory the plan gives this computer, sent by the server with every start. Absent:
 * the host's one ceiling (RAKAZO_COMPUTER_CPUS, RAKAZO_COMPUTER_MEMORY) applies, as before.
 */
export const computerSizeFields = {
  size: z
    .object({ vcpus: z.number().positive().max(1024), memoryGb: z.number().min(0.25).max(4096) })
    .optional(),
};
type SizeSpec = z.infer<typeof computerSizeFields.size>;

/** Docker's limits for a size; none for a start that names no size. */
export function sizeLimits(size: SizeSpec) {
  if (!size) return {};
  const memory = Math.floor(size.memoryGb * 1024 ** 3);
  // Swap is capped with memory, as the host's own ceiling does, so the limit holds.
  return { NanoCpus: Math.floor(size.vcpus * 1e9), Memory: memory, MemorySwap: memory };
}

/**
 * Moves a stopped computer to the plan's size before it starts, so an upgrade, a downgrade or a
 * changed setting reaches it on its next start. A running computer keeps its size: shrinking
 * memory under a live browser would kill it.
 */
export async function resizeStoppedComputer(
  container: Pick<Docker.Container, "update">,
  current: Pick<Docker.ContainerInspectInfo["HostConfig"], "NanoCpus" | "Memory" | "MemorySwap">,
  size: SizeSpec,
): Promise<void> {
  const limits = sizeLimits(size);
  if (
    Object.entries(limits).every(([key, value]) => current[key as keyof typeof current] === value)
  )
    return;
  await container.update(limits);
}
