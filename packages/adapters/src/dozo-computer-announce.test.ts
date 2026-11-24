import { deferred, flush } from "@rakazo/core/test-async";
import { expect, it, vi } from "vitest";
import { announceRunning, announceWhenStarted } from "./dozo-computer-announce.js";

const BOTS = [
  { id: "bot-1", thread: { id: "thread-1" } },
  { id: "bot-2", thread: { id: "thread-2" } },
  { id: "bot-3", thread: null },
];
const LONG_AGO = new Date("2024-01-01T00:00:00Z");

/** A computer row as the start leaves it (read after the start), its bots, and the event log. */
function fakeDeps(
  row: () => { state: string; runningSince: Date | null } | null,
  append = vi.fn(async () => ({}) as never),
) {
  const findUnique = vi.fn(async () => {
    const value = row();
    return value && { ...value, spaceId: "space-1" };
  });
  const deps = {
    prisma: { computer: { findUnique }, bot: { findMany: vi.fn(async () => BOTS) } },
    events: { append },
  } as never;
  return { deps, append, findUnique };
}

it("tells every bot thread a computer it woke is running, after the start finished", async () => {
  let runningSince: Date | null = null;
  const { deps, append, findUnique } = fakeDeps(() => ({ state: "running", runningSince }));
  const start = deferred<string>();
  const started = announceWhenStarted(deps, "computer-1", () => start.promise);
  await flush();
  // Nothing is read before or beside the start.
  expect(findUnique).not.toHaveBeenCalled();
  runningSince = new Date();
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

it("announces nothing for a computer that was already running, which keeps its clock", async () => {
  const { deps, append, findUnique } = fakeDeps(() => ({
    state: "running",
    runningSince: LONG_AGO,
  }));
  await announceWhenStarted(deps, "computer-1", async () => "ref");
  await vi.waitFor(() => expect(findUnique).toHaveBeenCalled());
  await flush();
  expect(append).not.toHaveBeenCalled();
});

it("announces nothing when the start fails", async () => {
  const { deps, append, findUnique } = fakeDeps(() => ({ state: "error", runningSince: null }));
  await expect(
    announceWhenStarted(deps, "computer-1", async () => {
      throw new Error("start failed");
    }),
  ).rejects.toThrow("start failed");
  await flush();
  expect(findUnique).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
});

it("announces nothing once the computer stopped running again", async () => {
  const { deps, append } = fakeDeps(() => ({ state: "suspending", runningSince: new Date() }));
  await announceWhenStarted(deps, "computer-1", async () => "ref");
  await flush();
  expect(append).not.toHaveBeenCalled();
});

it("answers the start at once while the announcement's read hangs, and a failed one changes nothing", async () => {
  const held = deferred<never>();
  const deps = {
    prisma: { computer: { findUnique: vi.fn(() => held.promise) } },
    events: { append: vi.fn() },
  } as never;
  await expect(announceWhenStarted(deps, "computer-1", async () => "ref")).resolves.toBe("ref");
  held.reject(new Error("database busy"));
  await flush();
});

it("gives up on a read past its deadline and announces nothing", async () => {
  const { deps, append } = fakeDeps(() => ({ state: "running", runningSince: new Date() }));
  const over = new AbortController();
  over.abort(new Error("deadline"));
  await expect(announceRunning(deps, "computer-1", LONG_AGO, over.signal)).rejects.toThrow(
    "deadline",
  );
  expect(append).not.toHaveBeenCalled();
});

it("starts a computer whose database client has no read for it", async () => {
  const deps = { prisma: { computer: {} }, events: { append: vi.fn() } } as never;
  await expect(announceWhenStarted(deps, "computer-1", async () => "ref")).resolves.toBe("ref");
  await flush();
});
