import { describe, expect, it, vi } from "vitest";

const expired = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./dozo-teach-expire.js", () => ({ expireTaughtSkillTeaching: expired }));

const { recordTeachingKeys } = await import("./dozo-teach-keys.js");

const actor = { spaceId: "space-1", userId: "user-1" } as never;
const computer = {
  id: "computer-1",
  homeKey: "bot-1",
  kind: "docker",
  providerRef: "ref-1",
  controlLeaseId: "lease-1",
};

function setup(
  skill: Record<string, unknown> | null = {},
  options: { computer?: Record<string, unknown> | null; endAfterSend?: string } = {},
) {
  let current: Record<string, unknown> | null = skill && {
    id: "skill-1",
    status: "recording",
    expiresAt: new Date(Date.now() + 60_000),
    recording: {
      events: [{ at: "t", kind: "pointer", x: 1, y: 1, type: "click" }],
      snapshots: [],
      dozoTargets: [{ eventIndex: 0, window: "Form" }],
    },
    ...skill,
  };
  const order: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async () => {
      order.push("lock");
      return 1;
    }),
    taughtSkill: {
      findUniqueOrThrow: vi.fn(async () => current),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        order.push("write");
        current = { ...current, ...data };
      }),
    },
    bot: {
      findUnique: vi.fn(async () => ({
        computer: options.computer === undefined ? computer : options.computer,
      })),
    },
  };
  const deps = {
    prisma: {
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
      taughtSkill: { findFirst: vi.fn(async () => current) },
    },
    sandbox: {
      sendInput: vi.fn(async () => {
        order.push("send");
        if (options.endAfterSend && current) current = { ...current, status: options.endAfterSend };
      }),
    },
  };
  const record = (keys: string[]) => recordTeachingKeys(deps as never, actor, "bot-1", keys);
  return { record, order, deps, current: () => current };
}

describe("recordTeachingKeys", () => {
  it("sends each key in order, then records them all in one write beside the targets", async () => {
    const { record, order, current } = setup();
    expect(await record(["a", "b", "Enter"])).toBe("recorded");
    expect(order).toEqual(["lock", "send", "send", "send", "lock", "write"]);
    const recording = current()?.recording as {
      events: Array<{ kind: string; key?: string }>;
      dozoTargets: unknown;
    };
    expect(recording.events.slice(1)).toEqual([
      expect.objectContaining({ kind: "key", key: "a" }),
      expect.objectContaining({ kind: "key", key: "b" }),
      expect.objectContaining({ kind: "key", key: "Enter" }),
    ]);
    expect(recording.dozoTargets).toEqual([{ eventIndex: 0, window: "Form" }]);
  });

  it("records without sending when the computer is not running", async () => {
    const { record, deps } = setup({}, { computer: null });
    expect(await record(["a"])).toBe("recorded");
    expect(deps.sandbox.sendInput).not.toHaveBeenCalled();
  });

  it("is idle with no recording, and stale once it ended", async () => {
    expect(await setup(null).record(["a"])).toBe("idle");
    const ended = setup({ status: "draft" });
    expect(await ended.record(["a"])).toBe("stale");
    expect(ended.deps.sandbox.sendInput).not.toHaveBeenCalled();
    const endedMeanwhile = setup({}, { endAfterSend: "draft" });
    expect(await endedMeanwhile.record(["a"])).toBe("stale");
    expect(endedMeanwhile.order).not.toContain("write");
  });

  it("ends a recording past its time, before or after the keys are sent", async () => {
    expired.mockClear();
    const late = setup({ expiresAt: new Date(Date.now() - 1) });
    expect(await late.record(["a"])).toBe("stale");
    expect(late.deps.sandbox.sendInput).not.toHaveBeenCalled();
    expect(expired).toHaveBeenCalledWith(expect.anything(), "skill-1");
    const timesOut = setup({}, {});
    timesOut.deps.sandbox.sendInput.mockImplementation(async () => {
      const skill = timesOut.current();
      if (skill) skill.expiresAt = new Date(Date.now() - 1);
    });
    expect(await timesOut.record(["a"])).toBe("stale");
    expect(expired).toHaveBeenCalledTimes(2);
  });
});
