import { sharedSpaceRoom } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { storeStepScreenshot } from "../../storage/thread-artifacts.js";
import type { RunContext } from "../assembly/run-context.js";
import { onToolCalled as upstreamOnToolCalled } from "./run-turn-tools.js";
import { saveLatestStepScreenshot as upstreamSaveLatest } from "./tool-step-calls.js";

export { keptTurnTranscript } from "./tool-step-calls.js";

/**
 * A reply keeps up to this many screenshots for its replay, its last one included. The run takes
 * them anyway, for the model; nothing here asks the computer for more.
 */
export const STEP_FRAMES_MAX = 24;
/** Room left for the reply's last screenshot, which the bot's later runs read, before any other. */
const LAST_FRAME_RESERVE_BYTES = 2 * 1024 * 1024;

type Shot = NonNullable<RunContext["state"]["reply"]["latestScreenshot"]>;
type Frame = {
  executionId: string;
  ordinal: number;
  dropped: boolean;
  artifactId?: string;
  stored: Promise<void>;
};
type Frames = {
  seen?: Uint8Array;
  count: number;
  stride: number;
  closed: boolean;
  frames: Frame[];
};

// One entry per reply while its run is in this process; the reply object is the key, so a reply
// that ends or is dropped takes its entry with it.
const replies = new WeakMap<object, Frames>();

function framesOf(ctx: RunContext): Frames {
  const reply = ctx.state.reply;
  const known = replies.get(reply);
  if (known) return known;
  const fresh: Frames = { count: 0, stride: 1, closed: false, frames: [] };
  replies.set(reply, fresh);
  return fresh;
}

function link(ctx: RunContext, frame: Frame) {
  const calls = ctx.state.reply.toolStepCalls;
  const call = calls.get(frame.executionId);
  if (!call || call.image || !frame.artifactId) return;
  calls.set(frame.executionId, { ...call, image: { artifactId: frame.artifactId } });
}

function unlink(ctx: RunContext, frame: Frame) {
  const calls = ctx.state.reply.toolStepCalls;
  const call = calls.get(frame.executionId);
  if (!call?.image || call.image.artifactId !== frame.artifactId) return;
  const { image: _, ...rest } = call;
  calls.set(frame.executionId, rest);
}

/** Keeps one screenshot as a frame of the reply, when the organization has room to spare. */
async function store(ctx: RunContext, state: Frames, frame: Frame, shot: Shot) {
  const { deps, run, bot, thread, runId } = ctx;
  if (!deps.artifacts) return;
  const room = await sharedSpaceRoom(deps.prisma, run.spaceId);
  if (room !== null && room < shot.data.byteLength + LAST_FRAME_RESERVE_BYTES) return;
  frame.artifactId = await storeStepScreenshot(
    { prisma: deps.prisma, artifacts: deps.artifacts },
    {
      spaceId: run.spaceId,
      userId: run.userId,
      botId: bot.id,
      groupId: thread.groupId ?? undefined,
      runId,
      operationId: `${runId}:${shot.executionId}:frame`,
      image: shot,
    },
  );
  if (!state.closed && !frame.dropped) link(ctx, frame);
}

/**
 * Every screenshot the reply took since the last call becomes a candidate frame. Frames are kept
 * at an even spread that grows as the reply does: past the limit, every other one goes and only
 * every second one after it is taken, so the first stays and the last is the reply's own.
 */
function noteScreenshot(ctx: RunContext) {
  const shot = ctx.state.reply.latestScreenshot;
  if (!shot) return;
  const state = framesOf(ctx);
  if (state.closed || state.seen === shot.data) return;
  state.seen = shot.data;
  const ordinal = state.count++;
  if (ordinal % state.stride !== 0) return;
  const frame: Frame = {
    executionId: shot.executionId,
    ordinal,
    dropped: false,
    stored: Promise.resolve(),
  };
  // Started at once, beside the run: a frame that cannot be kept is simply not there.
  frame.stored = bestEffort("keep a reply's step frame", store(ctx, state, frame, shot)).then(
    () => undefined,
  );
  state.frames.push(frame);
  while (state.frames.filter((kept) => !kept.dropped).length > STEP_FRAMES_MAX - 1) {
    state.stride *= 2;
    for (const kept of state.frames)
      if (!kept.dropped && kept.ordinal % state.stride !== 0) {
        kept.dropped = true;
        unlink(ctx, kept);
      }
  }
}

export async function onToolCalled(...args: Parameters<typeof upstreamOnToolCalled>) {
  noteScreenshot(args[0]);
  return upstreamOnToolCalled(...args);
}

/** Removes the reply's frames that ended up linked to none of its calls. */
async function removeUnlinked(ctx: RunContext, state: Frames) {
  await Promise.all(state.frames.map((frame) => frame.stored));
  const { deps, run, runId } = ctx;
  if (!deps.artifacts) return;
  const linked = new Set(
    [...ctx.state.reply.toolStepCalls.values()].flatMap((call) =>
      call.image ? [call.image.artifactId] : [],
    ),
  );
  const orphans = [
    ...new Set(state.frames.flatMap((frame) => frame.artifactId ?? [])),
  ].filter((id) => !linked.has(id));
  for (const id of orphans) {
    const row = await deps.prisma.artifact.findFirst({
      where: { id, spaceId: run.spaceId, runId },
      select: { storageKey: true },
    });
    if (!row) continue;
    await deps.prisma.artifact.deleteMany({ where: { id, spaceId: run.spaceId, runId } });
    await deps.artifacts.remove(row.storageKey, {
      operationId: `${runId}:frame-remove`,
      traceId: `${runId}:frame-remove`,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: ctx.bot.id,
      signal: new AbortController().signal,
    });
  }
}

/**
 * Saves the reply's last screenshot as before, then keeps the frames already stored beside it.
 * Frames still being written are left out, so the reply never waits for one. Without its last
 * screenshot the reply keeps none of the others, as before: the bot's next run reads the newest
 * one kept as what is on the screen now.
 */
export async function saveLatestStepScreenshot(ctx: RunContext): Promise<void> {
  const state = replies.get(ctx.state.reply);
  if (state) state.closed = true;
  const last = ctx.state.reply.latestScreenshot?.executionId;
  // The last screenshot is the upstream save's to keep or lose, as before.
  for (const frame of state?.frames ?? []) if (frame.executionId === last) unlink(ctx, frame);
  await upstreamSaveLatest(ctx);
  if (!state) return;
  const lastKept = last ? ctx.state.reply.toolStepCalls.get(last)?.image : undefined;
  if (!lastKept) for (const frame of state.frames) unlink(ctx, frame);
  else capFrames(ctx);
  void bestEffort("remove a reply's unused step frames", removeUnlinked(ctx, state));
}

/**
 * Holds the reply to the limit even when it resumed after a pause (which starts the spread again):
 * the first and the last stay, the rest at an even spread.
 */
function capFrames(ctx: RunContext) {
  const calls = ctx.state.reply.toolStepCalls;
  const shown = [...calls.entries()].filter(([, call]) => call.image);
  if (shown.length <= STEP_FRAMES_MAX) return;
  const keep = new Set(
    Array.from({ length: STEP_FRAMES_MAX }, (_, at) =>
      Math.round((at * (shown.length - 1)) / (STEP_FRAMES_MAX - 1)),
    ),
  );
  for (const [at, [executionId, call]] of shown.entries()) {
    if (keep.has(at)) continue;
    const { image: _, ...rest } = call;
    calls.set(executionId, rest);
  }
}
