import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  CommandRequest,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { SandboxAllowanceUsedError } from "@rakazo/adapter-kit";
import { BYOK_TIERS } from "@rakazo/contracts";
import type * as Db from "@rakazo/db";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";
import { operatorPaysFor, planRunServices } from "./dozo-plans.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { HostedModelCreditsRequiredError } from "./model-credit-observer.js";
import { hasHostedModelCredits } from "./model-selection.js";
import { autoReviewCheckerProvider } from "./run-auto-review.js";
import { resolveModelKey } from "./run-model.js";

// Runs on the branded tree only: the plans exist once the brand rules are applied.

// The plan's size has its own test beside the billing service; here it only has to answer.
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  planComputerSize: vi.fn(async () => "standard"),
}));

/** One organization: how it pays, and whether the server bills at all. */
const organization = {
  billingOn: true,
  mode: null as string | null,
  balanceMicros: 0n,
  billing: null as { status: string; byokTier: string; byokPriceCents: number } | null,
  ownConnection: false,
};

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

function harness() {
  const credits = () => ({ mode: organization.mode, balanceMicros: organization.balanceMicros });
  const prisma = {
    computer: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "computer-1",
        spaceId: "space-1",
        homeKey: "team-space-1",
        providerRef: "sandbox-1",
        // The provider the shipped stack runs: the operator's own host, which meters nothing.
        kind: "docker",
        scope: "team",
        state: "stopped",
        controlLeaseId: null,
        maintenanceId: null,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    computerRun: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    botDeletion: { findMany: vi.fn(async () => []) },
    space: {
      findUnique: vi.fn(async () => ({ organizationId: "org-1" })),
      findFirst: vi.fn(async () => ({ organization: { modelCredits: credits() } })),
    },
    member: { findUnique: vi.fn(async () => ({ role: "owner" })) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ modelCreditsEnabled: organization.billingOn })),
    },
    organization: {
      findUnique: vi.fn(async () => ({
        modelCredits: credits(),
        billing: organization.billing,
      })),
    },
    modelCreditAccount: {
      upsert: vi.fn(async () => ({ organizationId: "org-1", ...credits() })),
      findUnique: vi.fn(async () => credits()),
    },
    userModelCredential: {
      findFirst: vi.fn(async () => (organization.ownConnection ? { id: "credential-1" } : null)),
    },
    accessGrant: {
      aggregate: vi.fn(async () => ({ _sum: { creditCents: null }, _min: { appliedAt: null } })),
    },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
  };
  Object.assign(prisma, { $transaction: (work: (tx: unknown) => unknown) => work(prisma) });
  const ref = {
    id: "sandbox-1",
    botId: "team-space-1",
    kind: "docker" as const,
    providerRef: "sandbox-1",
    fresh: false,
  };
  const sandbox = {
    provision: vi.fn(async () => ref),
    prepare: vi.fn(async () => undefined),
    importWorkspace: vi.fn(async () => undefined),
    execute: vi.fn(async function* (_computer: unknown, _request: CommandRequest) {
      yield { type: "exit" as const, code: 0 };
    }),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    sandbox: sandbox as unknown as SandboxProvider,
    provision: sandbox.provision,
  };
}

async function boot({ prisma, sandbox }: ReturnType<typeof harness>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "dozo-plans-"));
  try {
    return await provisionComputer(
      {
        prisma,
        sandbox,
        home: {
          exportHome: vi.fn().mockReturnValue((async function* () {})()),
        } as unknown as AgentHomeStore,
        jobs: {
          enqueue: vi.fn(async () => undefined),
          cancel: vi.fn(async () => undefined),
          cancelIn: vi.fn(async () => undefined),
        } as unknown as JobPublisher,
        events: {} as ThreadEvents,
        dataDir,
      },
      "computer-1",
      context,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Asks for the operator's model the way a run does when the member has no connection of its own. */
function operatorModelKey(prisma: PrismaClient, billingEnabled: boolean) {
  const deps = {
    prisma,
    billingEnabled,
    deploymentModelKey: "operator-key",
    deploymentModelConfigured: true,
  } as unknown as ExecutorDeps;
  return resolveModelKey(deps, "user-1", "space-1", null, "anthropic", "any-model");
}

beforeEach(() => {
  Object.assign(organization, {
    billingOn: true,
    mode: null,
    balanceMicros: 0n,
    billing: null,
    ownConnection: false,
  });
  // The operator has a model of its own, paid with its own key.
  vi.stubEnv("PI_DEFAULT_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "operator-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a hosted computer", () => {
  it.each([null, "byok"])("is not started for an organization on Free (mode %s)", async (mode) => {
    organization.mode = mode;
    const stack = harness();
    await expect(boot(stack)).rejects.toBeInstanceOf(SandboxAllowanceUsedError);
    expect(stack.provision).not.toHaveBeenCalled();
  });

  it("is not started once a subscription has ended", async () => {
    organization.mode = "byok";
    organization.billing = {
      status: "canceled",
      byokTier: "pro",
      byokPriceCents: BYOK_TIERS.pro.monthlyPriceCents ?? 0,
    };
    const stack = harness();
    await expect(boot(stack)).rejects.toBeInstanceOf(SandboxAllowanceUsedError);
    expect(stack.provision).not.toHaveBeenCalled();
  });

  it("starts for a Premium subscriber", async () => {
    organization.mode = "byok";
    organization.billing = {
      status: "active",
      byokTier: "pro",
      byokPriceCents: BYOK_TIERS.pro.monthlyPriceCents ?? 0,
    };
    const stack = harness();
    await boot(stack);
    expect(stack.provision).toHaveBeenCalledOnce();
  });

  it("starts on a server that does not bill", async () => {
    organization.billingOn = false;
    const stack = harness();
    await boot(stack);
    expect(stack.provision).toHaveBeenCalledOnce();
  });
});

describe("the operator's own model", () => {
  it.each([null, "byok"])("is refused to an organization on Free (mode %s)", async (mode) => {
    organization.mode = mode;
    const { prisma } = harness();
    await expect(hasHostedModelCredits(prisma, context, "anthropic")).resolves.toBe(false);
    await expect(operatorModelKey(prisma, true)).rejects.toBeInstanceOf(
      HostedModelCreditsRequiredError,
    );
  });

  it("is metered for an organization that bought credits", async () => {
    organization.mode = "credits";
    organization.balanceMicros = 5_000_000n;
    const { prisma } = harness();
    await expect(hasHostedModelCredits(prisma, context, "anthropic")).resolves.toBe(true);
    const resolved = await operatorModelKey(prisma, true);
    expect(resolved).toMatchObject({ apiKey: "operator-key" });
    expect(resolved.callObserver).toBeDefined();
  });

  it("stays free to use on a server that does not bill", async () => {
    const { prisma } = harness();
    const resolved = await operatorModelKey(prisma, false);
    expect(resolved).toMatchObject({ apiKey: "operator-key" });
    expect(resolved.callObserver).toBeUndefined();
  });
});

describe("what the operator pays for by the call", () => {
  const premium = {
    status: "active",
    byokTier: "pro",
    byokPriceCents: BYOK_TIERS.pro.monthlyPriceCents ?? 0,
  };
  const services = { mediaGeneration: { id: "media" }, web: { id: "web" } };
  const hold = (prisma: PrismaClient, billingEnabled = true) => ({
    deps: { prisma, billingEnabled },
    run: context,
  });
  /** The operator's external reviewer, as a run asks for it. */
  const reviewer = (prisma: PrismaClient) =>
    autoReviewCheckerProvider(
      { prisma, billingEnabled: true } as unknown as ExecutorDeps,
      { ...context, runId: "run-1", threadId: "thread-1" },
      { memberChecker: false, registerSecrets: () => undefined },
      { provider: "jev", model: "any-model" },
    );

  beforeEach(() => {
    vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", "jev");
    vi.stubEnv("TYPESAFE_API_KEY", "operator-review-key");
  });

  it.each([null, "byok"])("is withheld from an organization on Free (mode %s)", async (mode) => {
    organization.mode = mode;
    organization.ownConnection = true;
    const { prisma } = harness();
    await expect(operatorPaysFor({ prisma, billingEnabled: true }, context)).resolves.toBe(false);
    await expect(planRunServices(services, hold(prisma))).resolves.toEqual({
      mediaGeneration: undefined,
      web: services.web,
    });
    await expect(reviewer(prisma)).rejects.toThrow("Selected checker connection is unavailable");
  });

  it("is withheld once a subscription has ended", async () => {
    organization.billing = { ...premium, status: "canceled" };
    const { prisma } = harness();
    await expect(planRunServices(services, hold(prisma))).resolves.toMatchObject({
      mediaGeneration: undefined,
    });
  });

  it("is withheld from someone who belongs to no organization here", async () => {
    const { prisma } = harness();
    vi.mocked(prisma.space.findUnique).mockResolvedValueOnce(null);
    await expect(operatorPaysFor({ prisma, billingEnabled: true }, context)).resolves.toBe(false);
  });

  it("is there for a Premium subscriber", async () => {
    organization.billing = premium;
    const { prisma } = harness();
    await expect(planRunServices(services, hold(prisma))).resolves.toBe(services);
    await expect(reviewer(prisma)).resolves.toBeDefined();
  });

  it("is there for an organization with a credit balance", async () => {
    organization.balanceMicros = 1n;
    const { prisma } = harness();
    await expect(planRunServices(services, hold(prisma))).resolves.toBe(services);
  });

  it("is there for everyone on a server that does not bill", async () => {
    const { prisma } = harness();
    await expect(planRunServices(services, hold(prisma, false))).resolves.toBe(services);
  });
});
