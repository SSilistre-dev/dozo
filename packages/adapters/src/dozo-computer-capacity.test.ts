import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type * as Db from "@rakazo/db";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { recordComputerRunStart } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { ComputerCapacityError } from "./dozo-computer-budget.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import { HostAwareSandbox } from "./host-aware-sandbox.js";
import { InMemoryJobQueue } from "./wakeup.js";

// Runs on the branded tree only: the lifecycle reaches the refusal through an anchored brand rule.
// The doubles follow computer-reuse.test.ts.

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  planComputerSize: vi.fn(async () => "standard"),
  recordComputerRunStart: vi.fn(async () => undefined),
}));

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
} satisfies AdapterContext;

async function fixture(state: string) {
  const directory = await mkdtemp(path.join(process.cwd(), ".computer-capacity-"));
  const row = {
    id: "computer",
    homeKey: "bot",
    providerRef: "provider",
    kind: "docker",
    scope: "team",
    state,
    restorePending: false,
    screenGeneration: 7,
    maintenanceId: null as string | null,
    controlLeaseId: null,
    updatedAt: new Date("2024-01-01T00:00:00Z"),
  };
  const updateMany = vi.fn(async ({ where, data }) => {
    if (
      Object.entries(where).some(
        ([key, value]) => key in row && row[key as keyof typeof row] !== value,
      )
    )
      return { count: 0 };
    // Prisma leaves a field set to undefined as it was.
    Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
    return { count: 1 };
  });
  const docker = new DockerSandboxProvider("http://supervisor.test", "test-token");
  const ref = {
    id: "provider",
    providerRef: "provider",
    botId: "bot",
    kind: "docker" as const,
    fresh: false,
  };
  const provision = vi.spyOn(docker, "provision");
  vi.spyOn(docker, "prepare").mockResolvedValue(undefined);
  vi.spyOn(docker, "execute").mockImplementation(async function* () {
    yield { type: "exit", code: 0 };
  });
  const prisma = {
    computer: { findUniqueOrThrow: vi.fn(async () => ({ ...row })), updateMany },
    // On the branded tree a computer on this host bills, so its Space is looked up for the allowance.
    space: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    sandbox: new HostAwareSandbox(docker, new FakeSandboxProvider(), async () => false),
    home: new LocalAgentHomeStore(directory),
    jobs: new InMemoryJobQueue(),
    events: {} as ThreadEvents,
    dataDir: directory,
  };
  return {
    row,
    ref,
    deps,
    provision,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(recordComputerRunStart).mockClear();
});

describe("a start the host refused for want of memory", () => {
  it.each(["stopped", "suspended", "error"])(
    "leaves a %s computer as it was, and the next start succeeds",
    async (state) => {
      const f = await fixture(state);
      try {
        f.provision.mockRejectedValueOnce(new ComputerCapacityError());
        await expect(provisionComputer(f.deps, "computer", context, "bot")).rejects.toBeInstanceOf(
          ComputerCapacityError,
        );
        expect(f.row).toMatchObject({ state, providerRef: "provider", kind: "docker" });
        expect(f.row.restorePending).toBe(false);
        expect(recordComputerRunStart).not.toHaveBeenCalled();

        f.provision.mockResolvedValueOnce(f.ref);
        await provisionComputer(f.deps, "computer", context, "bot");
        expect(f.row.state).toBe("running");
        expect(recordComputerRunStart).toHaveBeenCalledOnce();
      } finally {
        await f.cleanup();
      }
    },
  );

  it("still marks the computer failed for any other failure", async () => {
    const f = await fixture("stopped");
    try {
      f.provision.mockRejectedValueOnce(new Error("daemon unavailable"));
      await expect(provisionComputer(f.deps, "computer", context, "bot")).rejects.toThrow(
        "daemon unavailable",
      );
      expect(f.row.state).toBe("error");
    } finally {
      await f.cleanup();
    }
  });
});
