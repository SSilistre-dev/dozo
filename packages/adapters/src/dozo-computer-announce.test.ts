import { deferred, flush } from "@rakazo/core/test-async";
import { expect, it, vi } from "vitest";
import { announceWhenStarted } from "./dozo-computer-announce.js";

const BOTS = [
  { id: "bot-1", thread: { id: "thread-1" } },
  { id: "bot-2", thread: { id: "thread-2" } },
  { id: "bot-3", thread: null },
];

/** A computer row that reads `states` in turn, its bots, and the thread event log. */
function fakeDeps(states: Array<string | null>, append = vi.fn(async () => ({}) as never)) {
  const findUnique = vi.fn(async () => {
    const state = states.length > 1 ? states.shift() : states[0];
    return state === null ? null : { state, spaceId: "space-1" };
  });
  const findMany = vi.fn(async () => BOTS);
  const deps = {
    prisma: { computer: { findUnique }, bot: { findMany } },
    events: { append },
  } as never;
  return { deps, append, findUnique };
}

it("tells every bot thread a computer it woke is running, after the start finished", async () => {
  const { deps, append } = fakeDeps(["suspended", "running"]);
  const start = deferred<string>();
  const started = announceWhenStarted(deps, "computer-1", () => start.promise);
  await flush();
  expect(append).not.toHaveBeenCalled();
  start.resolve("ref");
  await expect(started).resolves.toBe("ref");
  await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(2));
  expect(append).toHaveBeenCalledWith({
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    type: "computer.status",
    payload: { status: "running" },
  });
  expect(append).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot-2" }));
});

it("announces nothing for a computer that was already running", async () => {
  const { deps, append } = fakeDeps(["running"]);
  await announceWhenStarted(deps, "computer-1", async () => "ref");
  await flush();
  expect(append).not.toHaveBeenCalled();
});

it("announces nothing when the start fails", async () => {
  const { deps, append } = fakeDeps(["suspended", "error"]);
  await expect(
    announceWhenStarted(deps, "computer-1", async () => {
      throw new Error("start failed");
    }),
  ).rejects.toThrow("start failed");
  await flush();
  expect(append).not.toHaveBeenCalled();
});

it("announces nothing once the computer stopped running again", async () => {
  const { deps, append } = fakeDeps(["suspended", "suspending"]);
  await announceWhenStarted(deps, "computer-1", async () => "ref");
  await flush();
  expect(append).not.toHaveBeenCalled();
});

it("answers the start without waiting for the announcement, and a failed one changes nothing", async () => {
  const held = deferred<never>();
  const { deps, append } = fakeDeps(
    ["stopped", "running"],
    vi.fn(() => held.promise),
  );
  await expect(announceWhenStarted(deps, "computer-1", async () => "ref")).resolves.toBe("ref");
  await vi.waitFor(() => expect(append).toHaveBeenCalled());
  held.reject(new Error("event log unavailable"));
  await flush();
});

it("still starts, and announces, when the state before cannot be read", async () => {
  const append = vi.fn(async () => ({}) as never);
  const findUnique = vi
    .fn()
    .mockRejectedValueOnce(new Error("database busy"))
    .mockResolvedValue({ state: "running", spaceId: "space-1" });
  const deps = {
    prisma: { computer: { findUnique }, bot: { findMany: vi.fn(async () => BOTS) } },
    events: { append },
  } as never;
  await expect(announceWhenStarted(deps, "computer-1", async () => "ref")).resolves.toBe("ref");
  await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(2));
});

it("starts a computer whose database client has no read for it", async () => {
  const deps = { prisma: { computer: {} }, events: { append: vi.fn() } } as never;
  await expect(announceWhenStarted(deps, "computer-1", async () => "ref")).resolves.toBe("ref");
});
