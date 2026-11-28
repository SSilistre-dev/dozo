import { deferred, flush } from "@rakazo/core/test-async";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  room: vi.fn(async (): Promise<number | null> => null),
  hold: vi.fn(),
  settle: vi.fn(),
  onToolCalled: vi.fn(async () => false),
  saveLatest: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  stepFrameRoom: mocks.room,
  holdStepFrame: mocks.hold,
  settleStepFrames: mocks.settle,
}));
vi.mock("./run-turn-tools.js", () => ({ onToolCalled: mocks.onToolCalled }));
vi.mock("./tool-step-calls.js", () => ({
  saveLatestStepScreenshot: mocks.saveLatest,
  keepToolStepResult: vi.fn(),
  keptToolArguments: vi.fn(),
  keptTurnTranscript: vi.fn(),
}));

import type { RunContext } from "../assembly/run-context.js";
import { onToolCalled } from "./dozo-step-frames-call.js";
import { STEP_FRAMES_MAX, saveLatestStepScreenshot } from "./dozo-step-frames.js";

type Call = { arguments?: string; image?: { artifactId: string } };
const own = {
  botId: "bot-1",
  userId: "user-1",
  groupId: null,
  helperBotId: null,
  externalConversationId: null,
};

function run(thread: Record<string, unknown> = own) {
  const calls = new Map<string, Call>();
  const reply = {
    toolStepCalls: calls,
    latestScreenshot: undefined as
      | { executionId: string; mimeType: "image/png"; data: Uint8Array }
      | undefined,
  };
  const removed: string[] = [];
  const put = vi.fn(async (file: { bytes: Uint8Array }) => ({
    id: `key-${file.bytes[0]}`,
    hash: "",
  }));
  const ctx = {
    state: { reply },
    run: { spaceId: "space-1", userId: "user-1" },
    bot: { id: "bot-1", userId: "user-1" },
    thread,
    runId: "run-1",
    deps: {
      artifacts: { put, remove: vi.fn(async (key: string) => void removed.push(key)) },
      prisma: {
        $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
          work({
            artifact: {
              create: async ({ data }: { data: { storageKey: string } }) => ({
                id: `art-${data.storageKey.slice(4)}`,
              }),
            },
          }),
      },
    },
  } as unknown as RunContext;
  let shots = 0;
  /** One tool call that returned a screenshot, then the next call starting. */
  const shoot = async (executionId: string) => {
    calls.set(executionId, { arguments: "{}" });
    reply.latestScreenshot = {
      executionId,
      mimeType: "image/png",
      data: new Uint8Array([shots++]),
    };
    await onToolCalled(ctx, { name: "browser_snapshot" } as never);
    await flush();
  };
  const images = () => [...calls.entries()].flatMap(([id, call]) => (call.image ? [id] : []));
  return { ctx, reply, calls, shoot, images, removed, put };
}

beforeEach(() => {
  mocks.room.mockReset().mockResolvedValue(null);
  mocks.hold.mockReset().mockResolvedValue({ allowed: true, removed: [] });
  mocks.settle.mockReset().mockResolvedValue([]);
  mocks.onToolCalled.mockClear();
  mocks.saveLatest.mockReset().mockImplementation(async (ctx: RunContext) => {
    const shot = ctx.state.reply.latestScreenshot;
    ctx.state.reply.latestScreenshot = undefined;
    const call = shot && ctx.state.reply.toolStepCalls.get(shot.executionId);
    if (call)
      ctx.state.reply.toolStepCalls.set(shot.executionId, {
        ...call,
        image: { artifactId: `last-${shot.executionId}` },
      });
  });
});

describe("a reply's step frames", () => {
  it("keeps each screenshot the reply already took on the call that took it, the last as before", async () => {
    const { ctx, shoot, images, calls } = run();
    for (const id of ["e1", "e2", "e3"]) await shoot(id);
    await saveLatestStepScreenshot(ctx);
    expect(images()).toEqual(["e1", "e2", "e3"]);
    expect(calls.get("e1")?.image?.artifactId).toBe("art-0");
    expect(calls.get("e3")?.image?.artifactId).toBe("last-e3");
    expect(mocks.onToolCalled).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["a group", { ...own, groupId: "g-1" }],
    ["a helper chat", { ...own, helperBotId: "bot-2" }],
    ["a chat app's conversation", { ...own, externalConversationId: "x-1" }],
    ["another member's chat", { ...own, userId: "user-2" }],
  ])("stores nothing for a reply that can never be replayed: %s", async (_name, thread) => {
    const { ctx, shoot, images, put } = run(thread);
    for (const id of ["e1", "e2"]) await shoot(id);
    await saveLatestStepScreenshot(ctx);
    expect(put).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(images()).toEqual(["e2"]);
  });

  it("keeps at most the limit, the first and the last included, at an even spread", async () => {
    const { ctx, shoot, images, put } = run();
    for (let at = 0; at < 100; at++) await shoot(`e${at}`);
    await saveLatestStepScreenshot(ctx);
    const kept = images();
    expect(kept.length).toBeLessThanOrEqual(STEP_FRAMES_MAX);
    expect(kept.length).toBeGreaterThan(STEP_FRAMES_MAX / 2);
    expect(kept[0]).toBe("e0");
    expect(kept.at(-1)).toBe("e99");
    const gaps = kept
      .slice(1, -1)
      .map((id, at) => Number(id.slice(1)) - Number(kept[at]!.slice(1)));
    expect(new Set(gaps).size).toBe(1);
    expect(put.mock.calls.length).toBeLessThan(2 * STEP_FRAMES_MAX);
  });

  it("keeps no other frame when the last screenshot could not be kept, as before", async () => {
    const { ctx, shoot, images } = run();
    for (const id of ["e1", "e2", "e3"]) await shoot(id);
    mocks.saveLatest.mockImplementationOnce(async () => undefined);
    await saveLatestStepScreenshot(ctx);
    expect(images()).toEqual([]);
  });

  it("writes one frame at a time and never after the reply ended", async () => {
    const { ctx, shoot, images, put } = run();
    const slow = deferred<{ id: string; hash: string }>();
    put.mockImplementationOnce(() => slow.promise);
    await shoot("e1");
    await shoot("e2");
    expect(put).toHaveBeenCalledTimes(1);
    await saveLatestStepScreenshot(ctx);
    expect(images()).toEqual(["e2"]);
    slow.resolve({ id: "key-slow", hash: "" });
    await vi.waitFor(() => expect(mocks.settle).toHaveBeenCalledOnce());
    expect(put).toHaveBeenCalledTimes(1);
    expect(mocks.settle.mock.calls[0]![1]).toMatchObject({ runId: "run-1", linked: ["last-e2"] });
  });

  it("stops writing once the organization has no room to spare, reading the room again once", async () => {
    const { ctx, shoot, put, removed } = run();
    mocks.hold.mockResolvedValue({ allowed: false, removed: [{ id: "x", storageKey: "key-old" }] });
    for (const id of ["e1", "e2", "e3", "e4"]) await shoot(id);
    await saveLatestStepScreenshot(ctx);
    await vi.waitFor(() => expect(mocks.settle).toHaveBeenCalled());
    expect(put).toHaveBeenCalledTimes(2);
    expect(mocks.room).toHaveBeenCalledTimes(2);
    expect(removed).toContain("key-old");
    expect(removed).toContain("key-0");
  });

  it("writes nothing when the room read before the first frame is already too small", async () => {
    const { ctx, shoot, put } = run();
    mocks.room.mockResolvedValue(0);
    for (const id of ["e1", "e2"]) await shoot(id);
    await saveLatestStepScreenshot(ctx);
    expect(put).not.toHaveBeenCalled();
  });

  it("counts each written frame against the room it read", async () => {
    const { ctx, shoot, put } = run();
    mocks.room.mockResolvedValue(1);
    for (const id of ["e1", "e2", "e3"]) await shoot(id);
    await saveLatestStepScreenshot(ctx);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("never fails the run when a frame cannot be stored, and removes its file", async () => {
    const { ctx, shoot, images, removed } = run();
    mocks.hold.mockRejectedValueOnce(new Error("database down"));
    for (const id of ["e1", "e2"]) await shoot(id);
    await expect(saveLatestStepScreenshot(ctx)).resolves.toBeUndefined();
    expect(images()).toEqual(["e2"]);
    expect(removed).toContain("key-0");
  });

  it("removes the files of frames the bot's budget made room by removing", async () => {
    const { ctx, shoot, removed } = run();
    mocks.hold.mockResolvedValueOnce({
      allowed: true,
      removed: [{ id: "o", storageKey: "key-o" }],
    });
    await shoot("e1");
    await shoot("e2");
    await saveLatestStepScreenshot(ctx);
    await vi.waitFor(() => expect(removed).toContain("key-o"));
  });

  it("removes the files of the frames the settle removed", async () => {
    const { ctx, shoot, removed } = run();
    mocks.settle.mockResolvedValue([{ id: "a", storageKey: "key-thinned" }]);
    for (const id of ["e1", "e2"]) await shoot(id);
    await saveLatestStepScreenshot(ctx);
    await vi.waitFor(() => expect(removed).toContain("key-thinned"));
  });

  it("holds a reply that resumed after a pause to the limit, its first and last frames kept", async () => {
    const { ctx, calls, shoot, images } = run();
    for (let at = 0; at < 30; at++)
      calls.set(`p${at}`, { arguments: "{}", image: { artifactId: `before-${at}` } });
    await shoot("e1");
    await saveLatestStepScreenshot(ctx);
    const kept = images();
    expect(kept).toHaveLength(STEP_FRAMES_MAX);
    expect(kept[0]).toBe("p0");
    expect(kept.at(-1)).toBe("e1");
  });

  it("takes a screenshot once, however many calls start after it", async () => {
    const { ctx, reply, shoot, put } = run();
    await shoot("e1");
    await onToolCalled(ctx, { name: "x" } as never);
    reply.latestScreenshot = undefined;
    await onToolCalled(ctx, { name: "x" } as never);
    await flush();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("settles a reply that took no screenshot of its own after a pause", async () => {
    const { ctx } = run();
    await saveLatestStepScreenshot(ctx);
    expect(mocks.saveLatest).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.settle).toHaveBeenCalledOnce());
  });
});
