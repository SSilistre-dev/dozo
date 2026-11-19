import { SandboxAllowanceUsedError } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const allowance = vi.hoisted(() => ({ usedUp: vi.fn(async () => false) }));
const upstream = vi.hoisted(() => ({
  start: vi.fn(async () => ({ id: "skill-1" })),
  save: vi.fn(async () => ({
    id: "skill-1",
    recording: {
      events: [
        { at: "t", kind: "key", key: "G" },
        { at: "t", kind: "clipboard", text: "Gizli-5678" },
        { at: "t", kind: "key", sensitive: true },
        { at: "t", kind: "pointer", x: 1, y: 2 },
        { at: "t", kind: "scroll", text: "3" },
      ],
      snapshots: [],
    },
  })),
  list: vi.fn(),
}));

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sandboxAllowanceUsedUp: allowance.usedUp,
}));
vi.mock("./taught-skills.js", () => ({ createTaughtSkillsService: () => upstream }));

const { createTaughtSkillsService, scrubTeachRecording } = await import("./dozo-taught-skills.js");

const actor = { userId: "ada", spaceId: "space-1", email: "ada@example.test" } as never;

function setup(computer: Record<string, unknown> | null, provisionKind?: () => Promise<string>) {
  const runs = { updateManyAndReturn: vi.fn() };
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1", computer })) },
    run: runs,
    $executeRaw: vi.fn(async () => 1),
  };
  const service = createTaughtSkillsService({
    prisma,
    sandbox: { provisionKind },
  } as never);
  return { service, prisma, runs };
}

const stopped = {
  spaceId: "space-1",
  kind: "docker",
  homeKey: "home-1",
  state: "stopped",
  providerRef: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  allowance.usedUp.mockResolvedValue(false);
});

describe("start", () => {
  it("refuses a plan with no computer time left before anything is cancelled", async () => {
    allowance.usedUp.mockResolvedValue(true);
    const { service, runs } = setup(stopped, async () => "cloud");
    await expect(service.start(actor, "bot-1", "Sign in")).rejects.toBeInstanceOf(
      SandboxAllowanceUsedError,
    );
    expect(allowance.usedUp).toHaveBeenCalledWith(expect.anything(), {
      spaceId: "space-1",
      kind: "cloud",
    });
    expect(upstream.start).not.toHaveBeenCalled();
    expect(runs.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("starts as upstream does when time is left, the computer runs or there is none", async () => {
    await setup(stopped).service.start(actor, "bot-1", "Sign in");
    expect(allowance.usedUp).toHaveBeenCalledWith(expect.anything(), {
      spaceId: "space-1",
      kind: "docker",
    });
    allowance.usedUp.mockResolvedValue(true);
    await setup({ ...stopped, state: "running", providerRef: "ref" }).service.start(
      actor,
      "bot-1",
      "Sign in",
    );
    await setup(null).service.start(actor, "bot-1", "Sign in");
    expect(upstream.start).toHaveBeenCalledTimes(3);
    expect(allowance.usedUp).toHaveBeenCalledOnce();
  });
});

describe("save", () => {
  it("forgets what was typed after upstream's save, and answers without it", async () => {
    const { service, prisma } = setup(null);
    const saved = await service.save(actor, "skill-1", "Sign in");
    expect(upstream.save).toHaveBeenCalledWith(actor, "skill-1", "Sign in");
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
    expect(JSON.stringify(saved)).not.toContain("Gizli-5678");
    expect(saved.recording.events).toEqual([
      { at: "t", kind: "key" },
      { at: "t", kind: "clipboard" },
      { at: "t", kind: "key", sensitive: true },
      { at: "t", kind: "pointer", x: 1, y: 2 },
      { at: "t", kind: "scroll", text: "3" },
    ]);
  });

  it("keeps upstream's other procedures", () => {
    expect(setup(null).service.list).toBe(upstream.list);
  });
});

describe("scrubTeachRecording", () => {
  it("updates the one row in a single statement", async () => {
    const executeRaw = vi.fn(async (..._args: unknown[]) => 1);
    await scrubTeachRecording({ $executeRaw: executeRaw } as never, "skill-9");
    const [sql, ...values] = executeRaw.mock.calls[0]!;
    expect((sql as string[]).join("?")).toContain("UPDATE taught_skills");
    expect(values).toEqual(["skill-9"]);
  });
});
