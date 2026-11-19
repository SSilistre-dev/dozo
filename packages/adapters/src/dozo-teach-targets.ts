import type { AdapterContext, ComputerObservation, SandboxProvider } from "@rakazo/adapter-kit";
import type { DozoTeachStoredTarget } from "@rakazo/contracts";
import { deadlineSignal, withAbort } from "@rakazo/core";
import { storedTeachTargets, TEACH_TARGETS_KEY } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { toComputerRef } from "./computer-support.js";
import type { TeachComputerInput } from "./teaching-session.js";

/*
 * What a click hit while teaching. No computer provider can say which element is under a point,
 * so the screen is observed just before the click lands: its window title and a small picture
 * around the point are kept in the recording beside its events until the save.
 */

/**
 * The most a click's capture may take: observing the screen before it lands, then cutting and
 * encoding the picture after. Past it the click keeps only its window.
 */
export const CLICK_OBSERVE_TIMEOUT_MS = 1_500;
/** The area around a click that is kept, in screen pixels, and the most a picture may weigh. */
export const CROP_WIDTH = 240;
export const CROP_HEIGHT = 120;
export const CROP_MAX_BYTES = 10_000;
/** A recording keeps pictures for this many clicks; later ones keep their window only. */
const MAX_IMAGES = 40;
const WINDOW_MAX = 200;

type Size = { width: number; height: number };
type Region = { left: number; top: number; width: number; height: number };

/**
 * The screen as it was just before a click landed, and what is left of the capture's time for
 * its picture.
 */
export type TeachClickObservation = {
  x: number;
  y: number;
  observation: ComputerObservation;
  budgetMs: number;
};
export type TeachClickTarget = Omit<DozoTeachStoredTarget, "eventIndex">;

/**
 * The picture's pixels around screen point (x, y): a CROP_WIDTH by CROP_HEIGHT screen area
 * centred on it, pushed inside the screen at an edge, then scaled to the picture, which may have
 * more or fewer pixels than the screen has points. Null for a point off the screen.
 */
export function cropRegion(screen: Size, picture: Size, x: number, y: number): Region | null {
  if (!(screen.width > 0 && screen.height > 0 && picture.width > 0 && picture.height > 0)) {
    return null;
  }
  if (!(x >= 0 && y >= 0 && x < screen.width && y < screen.height)) return null;
  const width = Math.min(CROP_WIDTH, screen.width);
  const height = Math.min(CROP_HEIGHT, screen.height);
  const left = Math.min(Math.max(x - width / 2, 0), screen.width - width);
  const top = Math.min(Math.max(y - height / 2, 0), screen.height - height);
  const scaleX = picture.width / screen.width;
  const scaleY = picture.height / screen.height;
  const pictureLeft = Math.floor(left * scaleX);
  const pictureTop = Math.floor(top * scaleY);
  return {
    left: pictureLeft,
    top: pictureTop,
    width: Math.max(1, Math.min(Math.round(width * scaleX), picture.width - pictureLeft)),
    height: Math.max(1, Math.min(Math.round(height * scaleY), picture.height - pictureTop)),
  };
}

/** The picture around the click as base64 WebP, at most CROP_WIDTH by CROP_HEIGHT pixels. */
export async function cropAroundClick(
  click: Omit<TeachClickObservation, "budgetMs">,
): Promise<string | undefined> {
  // sharp is a native addon; load it only when an image is processed.
  const { default: sharp } = await import("sharp");
  const { observation } = click;
  const picture = await sharp(observation.image).metadata();
  const region = cropRegion(
    observation,
    { width: picture.width ?? 0, height: picture.height ?? 0 },
    click.x,
    click.y,
  );
  if (!region) return undefined;
  for (const quality of [50, 25]) {
    const webp = await sharp(observation.image)
      .extract(region)
      .resize(CROP_WIDTH, CROP_HEIGHT, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
    if (webp.byteLength <= CROP_MAX_BYTES) return webp.toString("base64");
  }
  return undefined;
}

/**
 * Observes the screen before a recorded click lands, for at most CLICK_OBSERVE_TIMEOUT_MS. Only a
 * plain click or a press counts, and never protected input. A failed or slow observation gives
 * nothing: the click lands all the same.
 */
export async function observeTeachClick(
  sandbox: Pick<SandboxProvider, "observe">,
  computer: { homeKey: string; kind: string; providerRef: string | null },
  mapped: TeachComputerInput,
  context: AdapterContext,
): Promise<TeachClickObservation | undefined> {
  if (mapped.kind !== "pointer" || mapped.sensitive) return undefined;
  if (mapped.type !== "click" && mapped.type !== "down") return undefined;
  const started = performance.now();
  const signal = deadlineSignal(CLICK_OBSERVE_TIMEOUT_MS, context.signal);
  const observation = await bestEffort(
    "teach click observe",
    // Async, so a provider that throws before returning a promise is a failure like any other.
    withAbort(
      (async () => sandbox.observe(toComputerRef(computer), { ...context, signal }))(),
      signal,
    ),
  );
  if (!observation) return undefined;
  const budgetMs = Math.floor(CLICK_OBSERVE_TIMEOUT_MS - (performance.now() - started));
  return { x: mapped.x, y: mapped.y, observation, budgetMs };
}

/**
 * What is kept of an observed click: its window, and its picture when one could be made in the
 * time the observation left. The picture is not waited for past that: the click's request returns.
 */
export async function teachClickTarget(
  click: TeachClickObservation | undefined,
): Promise<TeachClickTarget | undefined> {
  if (!click) return undefined;
  const title = click.observation.activeWindow?.title?.trim().slice(0, WINDOW_MAX);
  const image =
    click.budgetMs > 0
      ? await bestEffort(
          "teach click crop",
          withAbort(cropAroundClick(click), deadlineSignal(click.budgetMs)),
        )
      : undefined;
  if (!title && !image) return undefined;
  return { ...(title ? { window: title } : {}), ...(image ? { image } : {}) };
}

/**
 * The recording about to be written, carrying the targets the stored one holds (upstream's parse
 * keeps only its own keys) and, for a click about to be appended as the next event, its target.
 */
export function withTeachClickTarget<R extends { events: unknown[] }>(
  skillId: string,
  stored: unknown,
  recording: R,
  target?: TeachClickTarget,
): R {
  const targets = storedTeachTargets(skillId, stored);
  if (target) {
    const pictured = targets.filter((kept) => kept.image).length;
    const { image, ...rest } = target;
    targets.push({
      eventIndex: recording.events.length,
      ...rest,
      ...(image && pictured < MAX_IMAGES ? { image } : {}),
    });
  }
  return targets.length ? { ...recording, [TEACH_TARGETS_KEY]: targets } : recording;
}
