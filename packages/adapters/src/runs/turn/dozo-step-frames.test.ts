import { deferred, flush } from "@rakazo/core/test-async";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  room: vi.fn(async (): Promise<number | null> => null),
  store: vi.fn(),
  onToolCalled: vi.fn(async () => false),
  saveLatest: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sharedSpaceRoom: mocks.room,
}));
vi.mock("../../storage/thread-artifacts.js", () => ({ storeStepScreenshot: mocks.store }));
vi.mock("./run-turn-tools.js", () => ({ onToolCalled: mocks.onToolCalled }));
vi.mock("./tool-step-calls.js", () => ({
  saveLatestStepScreenshot: mocks.saveLatest,
  keptTurnTranscript: vi.fn(),
}));

import type { RunContext } from "../assembly/run-context.js";
import { onToolCalled, STEP_FRAMES_MAX, saveLatestStepScreenshot } from "./dozo-step-frames.js";

type Call = { arguments?: string; image?: { artifactId: string } };

function run() {
  const calls = new Map<string, Call>();
  const reply = {
    toolStepCalls: calls,
    latestScreenshot: undefined as
      | { executionId: string; mimeType: "image/png"; data: Uint8Array }
      | undefined,
  };
  const removed: string[] = [];
  const rows = new Map<string, string>();
  const ctx = {
    state: { reply },
    run: { spaceId: "space-1", userId: "user-1" },
    bot: { id: "bot-1" },
    thread: { groupId: null },
    runId: "run-1",
    deps: {
      artifacts: { remove: vi.fn(async (key: string) => void removed.push(key)) },
      prisma: {
        artifact: {
          findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
            rows.has(where.id) ? { storageKey: rows.get(where.id) } : null,
          ),
          deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
            rows.delete(where.id);
            return { count: 1 };
          }),
        },
      },
    },
  } as unknown as RunContext;
  /** One tool call that returned a screenshot, then the next call starting. */
  const shoot = async (executionId: string) => {
    calls.set(executionId, { arguments: "{}" });
    reply.latestScreenshot = {
      executionId,
      mimeType: "image/png",
      data: new Uint8Array([executionId.length]),
    };
    await onToolCalled(ctx, { name: "browser_snapshot" } as never);
    await flush();
  };
  const images = () =>
    [...calls.entries()].flatMap(([id, call]) => (call.image ? [id] : []));
  return { ctx, reply, calls, shoot, images, rows, removed };
}

beforeEach(() => {
  mocks.room.mockReset().mockResolvedValue(null);
  mocks.store.mockReset().mockImplementation(async (_deps, input: { operationId: string }) => {
    const id = `art-${input.operationId.split(":")[1]}`;
    return id;
  });
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
    expect(calls.get("e3")?.image?.artifactId).toBe("last-e3");
    expect(mocks.onToolCalled).toHaveBeenCalledTimes(3);
  });

  it("keeps at most the limit, the first and the last included, at an even spread", async () => {
    const { ctx, shoot, images } = run();
    for (let at = 0; at < 100; at++) await shoot(`e${at}`);
    await saveLatestStepScreenshot(ctx);
    const kept = images();
    expect(kept.length).toBeLessThanOrEqual(STEP_FRAMES_MAX);
    expect(kept.length).toBeGreaterThan(STEP_FRAMES_MAX / 2);
    expect(kept[0]).toBe("e0");
    expect(kept.at(-1)).toBe("e99");
    const gaps = kept.slice(1, -1).map((id, at) => Number(id.slice(1)) - Number(kept[at]!.slice(1)));
    expect(new Set(gaps).size).toBe(1);
  });

  it("keeps no other frame when the last screenshot could not be kept, as before", async () => {
    const { ctx, shoot, images } = run();
    for (const id of ["e1", "e2", "e3"]) await shoot(id);
    mocks.saveLatest.mockImplementationOnce(async () => undefined);
    await saveLatestStepScreenshot(ctx);
    expect(images()).toEqual([]);
  });

  it("leaves room for the last screenshot: no frame once the organization is nearly full", async () => {
    const { ctx, shoot, images } = run();
    mocks.room.mockResolvedValue(1024 * 1024);
    for (const id of ["e1", "e2"]) await shoot(id);
    await saveLatestStepScreenshot(ctx);
    expect(mocks.store).not.toHaveBeenCalled();
    expect(images()).toEqual(["e2"]);
  });

  it("never fails the run when a frame cannot be stored", async () => {
    const { ctx, shoot, images } = run();
    mocks.store.mockRejectedValue(new Error("storage down"));
    for (const id of ["e1", "e2"]) await shoot(id);
    await expect(saveLatestStepScreenshot(ctx)).resolves.toBeUndefined();
    expect(images()).toEqual(["e2"]);
  });

  it("never waits for a frame still being written, and removes it once written", async () => {
    const { ctx, shoot, images, rows, removed } = run();
    const slow = deferred<string>();
    mocks.store.mockImplementationOnce(() => slow.promise);
    await shoot("e1");
    await shoot("e2");
    await saveLatestStepScreenshot(ctx);
    expect(images()).toEqual(["e2"]);
    rows.set("art-slow", "key-slow");
    slow.resolve("art-slow");
    await vi.waitFor(() => expect(removed).toEqual(["key-slow"]));
    expect(images()).toEqual(["e2"]);
  });

  it("removes the frames a longer reply thinned out, but none still on a call", async () => {
    const { ctx, shoot, rows, removed, images } = run();
    mocks.store.mockImplementation(async (_d, input: { operationId: string }) => {
      const id = `art-${input.operationId.split(":")[1]}`;
      rows.set(id, `key-${id}`);
      return id;
    });
    for (let at = 0; at < 30; at++) await shoot(`e${at}`);
    await saveLatestStepScreenshot(ctx);
    await vi.waitFor(() => expect(removed.length).toBeGreaterThan(0));
    const linked = new Set(images().map((id) => `key-art-${id}`));
    expect(removed.some((key) => linked.has(key))).toBe(false);
  });

  it("takes a screenshot once, however many calls start after it", async () => {
    const { ctx, reply, shoot } = run();
    await shoot("e1");
    await onToolCalled(ctx, { name: "x" } as never);
    reply.latestScreenshot = undefined;
    await onToolCalled(ctx, { name: "x" } as never);
    expect(mocks.store).toHaveBeenCalledTimes(1);
  });

  it("saves as before for a reply that took no screenshot", async () => {
    const { ctx } = run();
    await saveLatestStepScreenshot(ctx);
    expect(mocks.saveLatest).toHaveBeenCalledOnce();
  });
});
