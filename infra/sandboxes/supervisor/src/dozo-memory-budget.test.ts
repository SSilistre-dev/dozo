import { flush } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_IMAGE } from "./computer-spec.js";
import {
  COMPUTER_MEMORY_BUDGET_FULL,
  computerMemoryUsage,
  holdComputerMemory,
  memoryBudgetBytes,
  resumeMemoryBytes,
  runningComputerMemory,
} from "./dozo-memory-budget.js";

const GB = 1024 ** 3;

type Fake = {
  id: string;
  running: boolean;
  memory: number;
  labels?: Record<string, string>;
  image?: string;
  gone?: boolean;
  broken?: boolean;
};

/** A Docker with only what the budget reads: a list of running containers and their inspect. */
function fakeDocker(initial: Fake[] = []) {
  const containers = new Map(initial.map((item) => [item.id, item]));
  const listContainers = vi.fn(async (..._args: unknown[]) =>
    [...containers.values()]
      .filter((item) => item.running)
      .map((item) => ({
        Id: item.id,
        Image: item.image ?? "other:latest",
        Labels: item.labels ?? {},
      })),
  );
  const getContainer = vi.fn((id: string) => ({
    inspect: async () => {
      const item = containers.get(id);
      if (item?.broken) throw Object.assign(new Error("daemon down"), { statusCode: 500 });
      if (!item || item.gone) {
        throw Object.assign(new Error("no such container"), { statusCode: 404 });
      }
      return { HostConfig: { Memory: item.memory } };
    },
  }));
  return {
    containers,
    listContainers,
    getContainer,
    // biome-ignore lint/suspicious/noExplicitAny: the double has only the two calls the budget makes
    docker: { listContainers, getContainer } as any,
  };
}

const bot = (id: string, memory: number, running = true): Fake => ({
  id,
  running,
  memory,
  labels: { "rakazo.botId": `bot-${id}` },
});

beforeEach(() => {
  vi.stubEnv("RAKAZO_COMPUTER_MEMORY_TOTAL", "6g");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("memoryBudgetBytes", () => {
  it("reads the total in the memory setting's format, on every call", () => {
    expect(memoryBudgetBytes()).toBe(6 * GB);
    vi.stubEnv("RAKAZO_COMPUTER_MEMORY_TOTAL", "1536m");
    expect(memoryBudgetBytes()).toBe(1536 * 1024 ** 2);
  });

  it("is undefined when unset, blank or one of the no-limit spellings", () => {
    vi.stubEnv("RAKAZO_COMPUTER_MEMORY_TOTAL", "");
    expect(memoryBudgetBytes()).toBeUndefined();
    expect(memoryBudgetBytes("   ")).toBeUndefined();
    expect(memoryBudgetBytes("0")).toBeUndefined();
    expect(memoryBudgetBytes("unlimited")).toBeUndefined();
    vi.stubEnv("RAKAZO_COMPUTER_MEMORY_TOTAL", undefined);
    expect(memoryBudgetBytes()).toBeUndefined();
  });

  it("names the variable when the value is malformed", () => {
    expect(() => memoryBudgetBytes("lots")).toThrow(/RAKAZO_COMPUTER_MEMORY_TOTAL/);
  });
});

describe("the refusal text", () => {
  it("is the one the server's provider looks for", () => {
    expect(COMPUTER_MEMORY_BUDGET_FULL).toBe("Computer memory budget reached");
  });
});

describe("runningComputerMemory", () => {
  it("sums the ceilings of running bot computers, asked of Docker without `all`", async () => {
    const { docker, listContainers } = fakeDocker([
      bot("a", 2 * GB),
      bot("b", 1 * GB),
      bot("stopped", 4 * GB, false),
    ]);
    expect(await runningComputerMemory(docker)).toBe(3 * GB);
    expect(listContainers).toHaveBeenCalledExactlyOnceWith();
  });

  it("counts a legacy computer by its image and workspace label, and nothing else", async () => {
    const { docker } = fakeDocker([
      {
        id: "old",
        running: true,
        memory: GB,
        image: COMPUTER_IMAGE,
        labels: { "rakazo.workspaceId": "w" },
      },
      { id: "plain-image", running: true, memory: 2 * GB, image: COMPUTER_IMAGE },
      {
        id: "workspace-only",
        running: true,
        memory: 4 * GB,
        labels: { "rakazo.workspaceId": "w" },
      },
      { id: "database", running: true, memory: 8 * GB },
    ]);
    expect(await runningComputerMemory(docker)).toBe(GB);
  });

  it("leaves out the computer a start replaces", async () => {
    const { docker } = fakeDocker([bot("a", 2 * GB), bot("b", 1 * GB)]);
    expect(await runningComputerMemory(docker, "a")).toBe(1 * GB);
  });

  it("counts a computer that vanished between the list and the inspect as nothing", async () => {
    const { docker } = fakeDocker([bot("a", 2 * GB), { ...bot("b", 1 * GB), gone: true }]);
    expect(await runningComputerMemory(docker)).toBe(2 * GB);
  });

  it("counts a computer with no ceiling as nothing", async () => {
    const { docker } = fakeDocker([bot("a", 0)]);
    expect(await runningComputerMemory(docker)).toBe(0);
  });

  it("does not guess when Docker fails for another reason", async () => {
    const { docker } = fakeDocker([{ ...bot("a", GB), broken: true }]);
    await expect(runningComputerMemory(docker)).rejects.toThrow("daemon down");
  });
});

describe("holdComputerMemory", () => {
  it("admits a start that fits and holds until it is released", async () => {
    const { docker } = fakeDocker([bot("a", 2 * GB)]);
    const release = await holdComputerMemory(docker, 4 * GB);
    release();
  });

  it("refuses a start that would pass the budget, with the exact text", async () => {
    const { docker } = fakeDocker([bot("a", 2 * GB)]);
    await expect(holdComputerMemory(docker, 4 * GB + 1)).rejects.toThrow(
      new Error("Computer memory budget reached"),
    );
  });

  it("does not count a stopped computer", async () => {
    const { docker } = fakeDocker([bot("a", 4 * GB, false)]);
    (await holdComputerMemory(docker, 6 * GB))();
  });

  it("does not count the computer it replaces", async () => {
    const { docker } = fakeDocker([bot("a", 4 * GB), bot("b", 2 * GB)]);
    await expect(holdComputerMemory(docker, 4 * GB)).rejects.toThrow(COMPUTER_MEMORY_BUDGET_FULL);
    (await holdComputerMemory(docker, 4 * GB, "a"))();
  });

  it("gives the lock back after a refusal", async () => {
    const { docker } = fakeDocker([bot("a", 6 * GB)]);
    await expect(holdComputerMemory(docker, GB)).rejects.toThrow(COMPUTER_MEMORY_BUDGET_FULL);
    docker.listContainers.mockResolvedValueOnce([]);
    (await holdComputerMemory(docker, GB))();
  });

  it("gives the lock back when Docker fails", async () => {
    const { docker, containers } = fakeDocker([{ ...bot("a", GB), broken: true }]);
    await expect(holdComputerMemory(docker, GB)).rejects.toThrow("daemon down");
    containers.clear();
    (await holdComputerMemory(docker, GB))();
  });

  it("makes no Docker call and takes no lock without a budget", async () => {
    vi.stubEnv("RAKAZO_COMPUTER_MEMORY_TOTAL", "");
    const { docker, listContainers, getContainer } = fakeDocker([bot("a", 64 * GB)]);
    const first = await holdComputerMemory(docker, 64 * GB);
    // A second hold is admitted at once although the first was never released.
    const second = await holdComputerMemory(docker, 64 * GB);
    first();
    second();
    expect(listContainers).not.toHaveBeenCalled();
    expect(getContainer).not.toHaveBeenCalled();
  });

  it("names the variable when the budget is malformed, before taking the lock", async () => {
    vi.stubEnv("RAKAZO_COMPUTER_MEMORY_TOTAL", "lots");
    const { docker, listContainers } = fakeDocker();
    await expect(holdComputerMemory(docker, GB)).rejects.toThrow(/RAKAZO_COMPUTER_MEMORY_TOTAL/);
    expect(listContainers).not.toHaveBeenCalled();
  });

  it("lets a second start wait for the first, then refuses it once the first computer runs", async () => {
    const { docker, containers, listContainers } = fakeDocker();
    const first = await holdComputerMemory(docker, 4 * GB);

    let settled: "refused" | "admitted" | undefined;
    const second = holdComputerMemory(docker, 4 * GB).then(
      (release) => {
        settled = "admitted";
        release();
      },
      () => {
        settled = "refused";
      },
    );
    await flush();
    // Still waiting: it has not even counted yet.
    expect(settled).toBeUndefined();
    expect(listContainers).toHaveBeenCalledTimes(1);

    containers.set("first", bot("first", 4 * GB));
    first();
    await second;
    expect(settled).toBe("refused");
  });

  it("admits the second start when the first failed to start", async () => {
    const { docker } = fakeDocker();
    const first = await holdComputerMemory(docker, 4 * GB);

    let settled: "refused" | "admitted" | undefined;
    const second = holdComputerMemory(docker, 4 * GB).then(
      (release) => {
        settled = "admitted";
        release();
      },
      () => {
        settled = "refused";
      },
    );
    await flush();
    expect(settled).toBeUndefined();

    first();
    await second;
    expect(settled).toBe("admitted");
  });

  it("is safe to release twice, and the second release does not free a later hold", async () => {
    const { docker, containers } = fakeDocker();
    const first = await holdComputerMemory(docker, 4 * GB);
    first();
    const next = await holdComputerMemory(docker, 4 * GB);

    let settled = false;
    const third = holdComputerMemory(docker, 4 * GB).then(
      (release) => {
        settled = true;
        release();
      },
      () => {
        settled = true;
      },
    );
    first();
    await flush();
    expect(settled).toBe(false);

    containers.set("next", bot("next", 4 * GB));
    next();
    await third;
    expect(settled).toBe(true);
  });
});

describe("computerMemoryUsage", () => {
  it("reports what Docker holds and the budget", async () => {
    const { docker } = fakeDocker([bot("a", 2 * GB)]);
    expect(await computerMemoryUsage(docker)).toEqual({ usedBytes: 2 * GB, budgetBytes: 6 * GB });
  });

  it("leaves the budget out when there is none", async () => {
    vi.stubEnv("RAKAZO_COMPUTER_MEMORY_TOTAL", "");
    const { docker } = fakeDocker([bot("a", 2 * GB)]);
    expect(await computerMemoryUsage(docker)).toEqual({ usedBytes: 2 * GB });
  });
});

describe("resumeMemoryBytes", () => {
  it("is the size's memory when the start names a size", () => {
    expect(resumeMemoryBytes({ vcpus: 2, memoryGb: 2 }, 4 * GB)).toBe(2 * GB);
  });

  it("is the container's current memory when the start names none", () => {
    expect(resumeMemoryBytes(undefined, 4 * GB)).toBe(4 * GB);
  });

  it("is nothing for a container with no ceiling and no size", () => {
    expect(resumeMemoryBytes(undefined, undefined)).toBe(0);
  });
});
