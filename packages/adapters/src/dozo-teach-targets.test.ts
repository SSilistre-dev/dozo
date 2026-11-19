import { randomBytes } from "node:crypto";
import type { ComputerObservation } from "@rakazo/adapter-kit";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { TeachClickObservation } from "./dozo-teach-targets.js";
import {
  CLICK_OBSERVE_TIMEOUT_MS,
  CROP_HEIGHT,
  CROP_MAX_BYTES,
  CROP_WIDTH,
  cropAroundClick,
  cropRegion,
  observeTeachClick,
  teachClickTarget,
  withTeachClickTarget,
} from "./dozo-teach-targets.js";

const screen = { width: 1000, height: 600 };

async function frame(width: number, height: number, pixels?: Buffer): Promise<Uint8Array> {
  const image = pixels
    ? sharp(pixels, { raw: { width, height, channels: 3 } })
    : sharp({ create: { width, height, channels: 3, background: "#223344" } });
  return new Uint8Array(await image.png().toBuffer());
}

async function observation(
  width: number,
  height: number,
  extra: Partial<ComputerObservation> = {},
  pixels?: Buffer,
): Promise<ComputerObservation> {
  return {
    frameId: "f1",
    capturedAt: "2026-11-19T12:00:00.000Z",
    mimeType: "image/png",
    image: await frame(width, height, pixels),
    width,
    height,
    ...extra,
  };
}

describe("cropRegion", () => {
  it("centres the area on the click", () => {
    expect(cropRegion(screen, screen, 500, 300)).toEqual({
      left: 380,
      top: 240,
      width: CROP_WIDTH,
      height: CROP_HEIGHT,
    });
  });

  it("pushes the area inside the screen at every edge and corner", () => {
    expect(cropRegion(screen, screen, 0, 0)).toMatchObject({ left: 0, top: 0 });
    expect(cropRegion(screen, screen, 999, 599)).toMatchObject({
      left: 1000 - CROP_WIDTH,
      top: 600 - CROP_HEIGHT,
      width: CROP_WIDTH,
      height: CROP_HEIGHT,
    });
    expect(cropRegion(screen, screen, 10, 300)).toMatchObject({ left: 0, top: 240 });
  });

  it("keeps the whole screen when it is smaller than the area", () => {
    expect(cropRegion({ width: 100, height: 50 }, { width: 100, height: 50 }, 90, 40)).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 50,
    });
  });

  it("maps screen points onto a picture with more or fewer pixels", () => {
    // A 2x picture: the same area covers twice the pixels, from twice as far in.
    expect(cropRegion(screen, { width: 2000, height: 1200 }, 500, 300)).toEqual({
      left: 760,
      top: 480,
      width: 480,
      height: 240,
    });
    expect(cropRegion(screen, { width: 500, height: 300 }, 500, 300)).toEqual({
      left: 190,
      top: 120,
      width: 120,
      height: 60,
    });
    // Never past the picture's last pixel.
    const edge = cropRegion(screen, { width: 333, height: 201 }, 999, 599)!;
    expect(edge.left + edge.width).toBeLessThanOrEqual(333);
    expect(edge.top + edge.height).toBeLessThanOrEqual(201);
  });

  it("gives nothing for a point off the screen or a screen without size", () => {
    expect(cropRegion(screen, screen, -1, 5)).toBeNull();
    expect(cropRegion(screen, screen, 5, -1)).toBeNull();
    expect(cropRegion(screen, screen, 1000, 5)).toBeNull();
    expect(cropRegion(screen, screen, 5, 600)).toBeNull();
    expect(cropRegion({ width: 0, height: 600 }, screen, 5, 5)).toBeNull();
    expect(cropRegion(screen, { width: 1000, height: 0 }, 5, 5)).toBeNull();
  });
});

describe("cropAroundClick", () => {
  it("makes a small WebP no larger than the area", async () => {
    const base64 = await cropAroundClick({
      x: 500,
      y: 300,
      observation: await observation(1000, 600),
    });
    const meta = await sharp(Buffer.from(base64!, "base64")).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(CROP_WIDTH);
    expect(meta.height).toBe(CROP_HEIGHT);
    expect(Buffer.from(base64!, "base64").byteLength).toBeLessThan(CROP_MAX_BYTES);
  });

  it("scales the area down from a picture with more pixels than the screen has points", async () => {
    const base64 = await cropAroundClick({
      x: 5,
      y: 5,
      observation: { ...(await observation(2000, 1200)), width: 1000, height: 600 },
    });
    const meta = await sharp(Buffer.from(base64!, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([CROP_WIDTH, CROP_HEIGHT]);
  });

  it("gives nothing for a click off the screen or a picture that is too heavy", async () => {
    expect(
      await cropAroundClick({ x: 5000, y: 5, observation: await observation(1000, 600) }),
    ).toBeUndefined();
    // Noise does not compress: it stays over the limit at both qualities.
    const noise = randomBytes(1000 * 600 * 3);
    expect(
      await cropAroundClick({
        x: 500,
        y: 300,
        observation: await observation(1000, 600, {}, noise),
      }),
    ).toBeUndefined();
  });
});

describe("observeTeachClick", () => {
  const computer = { homeKey: "home-1", kind: "docker", providerRef: "ref-1" };
  const context = {
    operationId: "op",
    traceId: "op",
    userId: "u",
    spaceId: "s",
    botId: "b",
  } as never;
  const click = { kind: "pointer", type: "click", x: 5, y: 6 } as never;

  it("observes before a click or a press, with the time it may take", async () => {
    const seen = await observation(1000, 600);
    const observe = vi.fn(async () => seen);
    expect(await observeTeachClick({ observe }, computer, click, context)).toEqual({
      x: 5,
      y: 6,
      observation: seen,
    });
    const down = { kind: "pointer", type: "down", x: 1, y: 2 } as never;
    expect((await observeTeachClick({ observe }, computer, down, context))?.x).toBe(1);
    const given = (observe.mock.calls[0] as unknown as [unknown, { signal: AbortSignal }])[1]
      .signal;
    expect(given.aborted).toBe(false);
    expect(CLICK_OBSERVE_TIMEOUT_MS).toBeLessThanOrEqual(1_500);
  });

  it("does not observe other input, nor protected input", async () => {
    const observe = vi.fn(async () => observation(1000, 600));
    for (const mapped of [
      { kind: "pointer", type: "move", x: 1, y: 1 },
      { kind: "pointer", type: "up", x: 1, y: 1 },
      { kind: "key", key: "a" },
      { kind: "scroll", direction: "down" },
      { kind: "pointer", type: "click", x: 1, y: 1, sensitive: true },
    ]) {
      expect(
        await observeTeachClick({ observe }, computer, mapped as never, context),
      ).toBeUndefined();
    }
    expect(observe).not.toHaveBeenCalled();
  });

  it("gives nothing, and does not throw, when the screen cannot be read or is too slow", async () => {
    const failing = vi.fn(async () => {
      throw new Error("no screen");
    });
    expect(await observeTeachClick({ observe: failing }, computer, click, context)).toBeUndefined();
    // Also a provider that throws before it returns a promise.
    const throwing = vi.fn(() => {
      throw new Error("no screen");
    });
    expect(
      await observeTeachClick({ observe: throwing }, computer, click, context),
    ).toBeUndefined();
    const slow = vi.fn(() => new Promise<ComputerObservation>(() => undefined));
    const late = { ...(context as object), signal: AbortSignal.abort() } as never;
    expect(await observeTeachClick({ observe: slow }, computer, click, late)).toBeUndefined();
  });
});

describe("teachClickTarget", () => {
  const seen = async (title?: string): Promise<TeachClickObservation> => ({
    x: 500,
    y: 300,
    observation: await observation(
      1000,
      600,
      title === undefined ? {} : { activeWindow: { id: "w", title } },
    ),
  });

  it("keeps the window and a picture", async () => {
    const target = await teachClickTarget(await seen("  Form – Browser  "));
    expect(target?.window).toBe("Form – Browser");
    expect(target?.image).toEqual(expect.any(String));
  });

  it("keeps the window when no picture could be made, and nothing when there is neither", async () => {
    const off = { ...(await seen("Form")), x: 5000 };
    expect(await teachClickTarget(off)).toEqual({ window: "Form" });
    expect(
      await teachClickTarget({ ...off, observation: await observation(1000, 600) }),
    ).toBeUndefined();
    expect(await teachClickTarget(undefined)).toBeUndefined();
    expect((await teachClickTarget({ ...(await seen("x".repeat(500))) }))?.window).toHaveLength(
      200,
    );
  });
});

describe("withTeachClickTarget", () => {
  const recording = { events: [{}, {}, {}], snapshots: [] };

  it("stores the target with the index of the event about to be appended", () => {
    const next = withTeachClickTarget("skill-1", { events: [] }, recording, {
      window: "Form",
      image: "AAAA",
    });
    expect(next).toEqual({
      ...recording,
      dozoTargets: [{ eventIndex: 3, window: "Form", image: "AAAA" }],
    });
  });

  it("carries the targets already stored, and adds none without a click", () => {
    const stored = { dozoTargets: [{ eventIndex: 0, window: "A", image: "BBBB" }] };
    expect(withTeachClickTarget("skill-1", stored, recording)).toEqual({
      ...recording,
      dozoTargets: stored.dozoTargets,
    });
    expect(withTeachClickTarget("skill-1", {}, recording)).toBe(recording);
    // Targets in another shape are dropped, not guessed at.
    expect(withTeachClickTarget("skill-1", { dozoTargets: "x" }, recording)).toBe(recording);
  });

  it("keeps the window but not the picture once a recording holds forty pictures", () => {
    const stored = {
      dozoTargets: Array.from({ length: 40 }, (_, eventIndex) => ({ eventIndex, image: "AAAA" })),
    };
    const next = withTeachClickTarget("skill-1", stored, recording, { window: "W", image: "CCCC" });
    expect(next.dozoTargets?.at(-1)).toEqual({ eventIndex: 3, window: "W" });
    expect(next.dozoTargets).toHaveLength(41);
  });
});
