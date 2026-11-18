import type Docker from "dockerode";
import { COMPUTER_IMAGE, parseMemoryBytes } from "./computer-spec.js";
import { sizeLimits } from "./dozo-computer-size.js";

/** The refusal's exact text. The server's provider matches it, from its own copy of this line. */
export const COMPUTER_MEMORY_BUDGET_FULL = "Computer memory budget reached";

const BUDGET_ENV = "RAKAZO_COMPUTER_MEMORY_TOTAL";

type Listing = Pick<Docker, "listContainers" | "getContainer">;

/**
 * The memory the running computers may hold together, in bytes. Undefined when the operator set
 * none (unset, blank, or the "no limit" spellings the memory setting has). Read on every call so a
 * test and a restart behave the same.
 */
export function memoryBudgetBytes(raw = process.env[BUDGET_ENV]): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return parseMemoryBytes(BUDGET_ENV, raw) || undefined;
}

function isBotComputer(item: Docker.ContainerInfo): boolean {
  const labels = item.Labels ?? {};
  if (labels["rakazo.botId"]) return true;
  // Older computers carry the workspace label and are known by their image.
  return item.Image === COMPUTER_IMAGE && Boolean(labels["rakazo.workspaceId"]);
}

/**
 * The memory ceilings of the bot computers Docker says are running, paused or restarting (created
 * and exited ones hold none). The figure comes from Docker alone, never from remembered state.
 */
export async function runningComputerMemory(docker: Listing, exceptId?: string): Promise<number> {
  const listed = await docker.listContainers();
  const ceilings = await Promise.all(
    listed
      .filter((item) => item.Id !== exceptId && isBotComputer(item))
      .map(async (item) => {
        try {
          const info = await docker.getContainer(item.Id).inspect();
          return info.HostConfig?.Memory ?? 0;
        } catch (error) {
          // Gone between the list and the inspect: it holds nothing now.
          if ((error as { statusCode?: number }).statusCode === 404) return 0;
          throw error;
        }
      }),
  );
  return ceilings.reduce((sum, bytes) => sum + bytes, 0);
}

// ponytail: one lock in this process. It holds while the supervisor is the only process that
// starts computers on its host; a second supervisor on the same Docker would need a lock in Docker.
let tail: Promise<void> = Promise.resolve();

/**
 * Admits a start of `needBytes` or refuses it. Returns the `release` the caller calls once the
 * computer has started or failed. The supervisor is the only process that starts computers on a
 * host, so one lock around "count, then start" is enough for two starts never to pass the budget
 * together: a computer still starting is not yet running for Docker, which is why the lock covers
 * the start itself and not only the count. With no budget there is no lock and no Docker call.
 * Take it last, after the bot, space and screen locks: a stuck screen command then never holds
 * the host's lock, and nothing is waited for while it is held but Docker and the start.
 */
export async function holdComputerMemory(
  docker: Listing,
  needBytes: number,
  exceptId?: string,
): Promise<() => void> {
  const budget = memoryBudgetBytes();
  if (budget === undefined) return () => undefined;

  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const previous = tail;
  tail = previous.then(() => gate);
  await previous;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    open();
  };
  try {
    if ((await runningComputerMemory(docker, exceptId)) + needBytes > budget) {
      throw new Error(COMPUTER_MEMORY_BUDGET_FULL);
    }
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

export async function computerMemoryUsage(
  docker: Listing,
): Promise<{ usedBytes: number; budgetBytes?: number }> {
  const budgetBytes = memoryBudgetBytes();
  const usedBytes = await runningComputerMemory(docker);
  return budgetBytes === undefined ? { usedBytes } : { usedBytes, budgetBytes };
}

/**
 * The memory a resumed computer will have: the size's when the start names one, else what the
 * stopped container already has.
 */
export function resumeMemoryBytes(
  size: Parameters<typeof sizeLimits>[0],
  current: number | undefined,
): number {
  return sizeLimits(size).Memory ?? current ?? 0;
}
