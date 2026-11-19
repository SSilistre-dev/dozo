import { flush } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";

const expired = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./dozo-teach-expire.js", () => ({ expireTaughtSkillTeaching: expired }));

const { KEY_ORDER_WAIT_MS, recordTeachingKeys } = await import("./dozo-teach-keys.js");

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
      taughtSkill: {
        findFirst: vi.fn(async () => current),
        findUnique: vi.fn(async () => current),
      },
    },
    sandbox: {
      act: vi.fn(async (_ref: unknown, request: { actions: unknown[] }) => {
        order.push(`act ${request.actions.length}`);
        if (options.endAfterSend && current) current = { ...current, status: options.endAfterSend };
      }),
    },
  };
  const record = (keys: string[], keyOrder?: { page: string; seq: number; after?: number }) =>
    recordTeachingKeys(deps as never, actor, "bot-1", keys, keyOrder);
  return { record, order, deps, current: () => current };
}

describe("recordTeachingKeys", () => {
  it("sends each key in order, then records them all in one write beside the targets", async () => {
    const { record, order, current, deps } = setup();
    expect(await record(["a", "b", "Enter"])).toBe("recorded");
    expect(order).toEqual(["lock", "act 3", "lock", "write"]);
    expect(deps.sandbox.act.mock.calls[0]?.[1]).toEqual({
      actions: [
        { kind: "clipboard", text: "a" },
        { kind: "clipboard", text: "b" },
        { kind: "key", key: "Return" },
      ],
      observe: false,
    });
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
    expect(deps.sandbox.act).not.toHaveBeenCalled();
  });

  it("splits many keys into calls the computer takes", async () => {
    const { record, order } = setup();
    expect(await record(Array.from({ length: 50 }, () => "x"))).toBe("recorded");
    expect(order).toEqual(["lock", "act 24", "act 24", "act 2", "lock", "write"]);
  });

  it("is idle with no recording, and stale once it ended", async () => {
    expect(await setup(null).record(["a"])).toBe("idle");
    const ended = setup({ status: "draft" });
    expect(await ended.record(["a"])).toBe("stale");
    expect(ended.deps.sandbox.act).not.toHaveBeenCalled();
    const endedMeanwhile = setup({}, { endAfterSend: "draft" });
    expect(await endedMeanwhile.record(["a"])).toBe("stale");
    expect(endedMeanwhile.order).not.toContain("write");
  });

  it("ends a recording past its time, before or after the keys are sent", async () => {
    expired.mockClear();
    const late = setup({ expiresAt: new Date(Date.now() - 1) });
    expect(await late.record(["a"])).toBe("stale");
    expect(late.deps.sandbox.act).not.toHaveBeenCalled();
    expect(expired).toHaveBeenCalledWith(expect.anything(), "skill-1");
    const timesOut = setup({}, {});
    timesOut.deps.sandbox.act.mockImplementation(async () => {
      const skill = timesOut.current();
      if (skill) skill.expiresAt = new Date(Date.now() - 1);
    });
    expect(await timesOut.record(["a"])).toBe("stale");
    expect(expired).toHaveBeenCalledTimes(2);
  });

  describe("in the page's order", () => {
    afterEach(() => vi.useRealTimers());
    const typed = (skill: Record<string, unknown> | null) =>
      ((skill?.recording ?? { events: [] }) as { events: Array<{ key?: string }> }).events.flatMap(
        (event) => (event.key ? [event.key] : []),
      );

    it("types and records a batch only after the one sent before it, whichever arrives first", async () => {
      const { record, deps, current } = setup();
      // Sent as the page went away, it arrives while the batch before it is still on its way.
      const late = record(["c"], { page: "page-1", seq: 2, after: 1 });
      await flush();
      expect(deps.sandbox.act).not.toHaveBeenCalled();
      expect(await record(["a", "b"], { page: "page-1", seq: 1 })).toBe("recorded");
      expect(await late).toBe("recorded");
      expect(deps.sandbox.act.mock.calls.map(([, request]) => request.actions.length)).toEqual([
        2, 1,
      ]);
      expect(typed(current())).toEqual(["a", "b", "c"]);
      expect(current()?.recording).toMatchObject({ dozoKeyOrder: { page: "page-1", seq: 2 } });
      // A batch that names no earlier one never waits.
      expect(await record(["d"], { page: "page-1", seq: 3 })).toBe("recorded");
      expect(current()?.recording).toMatchObject({ dozoKeyOrder: { page: "page-1", seq: 3 } });
    });

    it("waits no longer than its bound for a batch that never comes, nor once the recording ended", async () => {
      vi.useFakeTimers();
      const { record, current } = setup({
        recording: { events: [], snapshots: [], dozoKeyOrder: { page: "other", seq: 9 } },
      });
      let done = false;
      const late = record(["z"], { page: "page-1", seq: 5, after: 4 }).then((outcome) => {
        done = true;
        return outcome;
      });
      await vi.advanceTimersByTimeAsync(KEY_ORDER_WAIT_MS - 100);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(await late).toBe("recorded");
      expect(typed(current())).toEqual(["z"]);
      expect(current()?.recording).toMatchObject({ dozoKeyOrder: { page: "page-1", seq: 5 } });
      vi.useRealTimers();
      const ended = setup({ status: "draft" });
      expect(await ended.record(["a"], { page: "page-1", seq: 2, after: 1 })).toBe("stale");
      expect(ended.deps.prisma.taughtSkill.findUnique).toHaveBeenCalledOnce();
    });
  });
});
