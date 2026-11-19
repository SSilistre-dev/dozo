import type { ComputerObservation } from "@rakazo/adapter-kit";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { emptyRecording, recordTeachingInputEvent } from "./teaching-session.js";

// Runs on the branded tree, where the fork's hooks sit in `recordTeachingInputEvent`: what the
// screen showed just before a click lands is kept with the recording, and never stands in its way.

const actor = { spaceId: "space-1", userId: "user-1" } as never;
const computer = {
  id: "computer-1",
  homeKey: "bot-1",
  kind: "e2b",
  providerRef: "boat-1",
  controlHolder: "user",
  controlBotId: "bot-1",
  controlLeaseId: "lease-1",
};

async function screen(title: string): Promise<ComputerObservation> {
  const image = await sharp({
    create: { width: 800, height: 600, channels: 3, background: "#102030" },
  })
    .png()
    .toBuffer();
  return {
    frameId: "f1",
    capturedAt: "2026-11-19T12:00:00.000Z",
    mimeType: "image/png",
    image: new Uint8Array(image),
    width: 800,
    height: 600,
    activeWindow: { id: "w1", title },
  };
}

function setup(observe: () => Promise<ComputerObservation>) {
  let current: Record<string, unknown> = {
    id: "skill-1",
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    status: "recording",
    recording: emptyRecording(),
    expiresAt: new Date(Date.now() + 60_000),
  };
  const order: string[] = [];
  const tx = {
    $executeRaw: vi.fn(),
    taughtSkill: {
      findUniqueOrThrow: vi.fn(async () => current),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        current = { ...current, ...data };
      }),
    },
    bot: { findUnique: vi.fn(async () => ({ id: "bot-1", computer })) },
  };
  const deps = {
    prisma: {
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
      taughtSkill: { findFirst: vi.fn(async () => current) },
    },
    sandbox: {
      observe: vi.fn(async () => {
        order.push("observe");
        return observe();
      }),
      sendInput: vi.fn(async () => {
        order.push("send");
      }),
    },
  };
  const record = (mapped: Record<string, unknown>) =>
    recordTeachingInputEvent(deps as never, actor, "bot-1", mapped as never);
  return { record, order, deps, recording: () => current.recording as Record<string, unknown> };
}

const click = { kind: "pointer", x: 400, y: 300, button: "left", type: "click" };

describe("a recorded click", () => {
  it("is observed before it lands, and its window and picture are kept with its event", async () => {
    const { record, order, recording } = setup(() => screen("Form – Browser"));
    await record({ kind: "key", key: "a" });
    order.length = 0;
    expect(await record(click)).toBe("recorded");
    expect(order).toEqual(["observe", "send"]);
    const kept = recording();
    expect((kept.events as unknown[]).length).toBe(2);
    expect(kept.dozoTargets).toEqual([
      { eventIndex: 1, window: "Form – Browser", image: expect.any(String) },
    ]);
  });

  it("still lands, with no target, when the screen cannot be read", async () => {
    const { record, order, recording } = setup(async () => {
      throw new Error("no screen");
    });
    expect(await record(click)).toBe("recorded");
    expect(order).toEqual(["observe", "send"]);
    expect((recording().events as unknown[]).length).toBe(1);
    expect(recording().dozoTargets).toBeUndefined();
  });

  it("is not observed when it is protected input or not a click", async () => {
    const { record, deps } = setup(() => screen("x"));
    await record({ kind: "key", key: "a" });
    await record({ ...click, type: "move" });
    expect(deps.sandbox.observe).not.toHaveBeenCalled();
  });

  it("keeps the targets of earlier clicks when a later event is recorded", async () => {
    const { record, recording } = setup(() => screen("Form"));
    await record(click);
    await record({ kind: "key", key: "b" });
    await record({ ...click, x: 10, y: 10 });
    expect(
      (recording().dozoTargets as Array<{ eventIndex: number }>).map((t) => t.eventIndex),
    ).toEqual([0, 2]);
  });
});
