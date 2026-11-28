import { createHash } from "node:crypto";
import { stepScreenshotMimeType } from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import {
  dozoReplayableChat,
  holdStepFrame,
  STEP_FRAME_PENDING,
  settleStepFrames,
  stepFrameRoom,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RunContext } from "../assembly/run-context.js";
import { saveLatestStepScreenshot as upstreamSaveLatest } from "./tool-step-calls.js";

export { keepToolStepResult, keptToolArguments, keptTurnTranscript } from "./tool-step-calls.js";

/**
 * A reply keeps up to this many screenshots for its replay, its last one included. The run takes
 * them anyway, for the model; nothing here asks the computer for more.
 */
export const STEP_FRAMES_MAX = 24;
/** A frame write that takes longer is given up, so it never holds the run's context. */
const FRAME_WRITE_MS = 15_000;

type Shot = NonNullable<RunContext["state"]["reply"]["latestScreenshot"]>;
type Frame = { executionId: string; ordinal: number; dropped: boolean; artifactId?: string };
type Frames = {
  eligible: boolean;
  seen?: Uint8Array;
  count: number;
  stride: number;
  closed: boolean;
  frames: Frame[];
  /** Bytes extra frames may still take, read once per run; null without a limit. */
  room?: number | null;
  refreshed: boolean;
  /** One write at a time, in the order the screenshots came. */
  writer: Promise<void>;
};

// One entry per reply while its run is in this process; the reply object is the key, so a reply
// that ends or is dropped takes its entry with it.
const replies = new WeakMap<object, Frames>();

function framesOf(ctx: RunContext): Frames {
  const reply = ctx.state.reply;
  const known = replies.get(reply);
  if (known) return known;
  const fresh: Frames = {
    eligible:
      Boolean(ctx.deps.artifacts) && dozoReplayableChat(ctx.thread, ctx.bot, ctx.run.userId),
    count: 0,
    stride: 1,
    closed: false,
    frames: [],
    refreshed: false,
    writer: Promise.resolve(),
  };
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

function context(ctx: RunContext, operation: string) {
  const operationId = `${ctx.runId}:${operation}`;
  return {
    operationId,
    traceId: operationId,
    spaceId: ctx.run.spaceId,
    userId: ctx.run.userId,
    botId: ctx.bot.id,
    signal: deadlineSignal(FRAME_WRITE_MS),
  };
}

async function removeFiles(ctx: RunContext, rows: { storageKey: string }[]) {
  const artifacts = ctx.deps.artifacts;
  if (!artifacts) return;
  for (const row of rows)
    await bestEffort(
      "remove a replay frame's file",
      artifacts.remove(row.storageKey, context(ctx, "frame-remove")),
    );
}

/**
 * Writes one extra frame: its file, then its row in a transaction held to the organization's room
 * and the bot's frame budget (`holdStepFrame`), so the reply's last screenshot keeps its room.
 * Never shares a file with another reply: its hash is its own, so no other write finds it.
 */
async function writeFrame(ctx: RunContext, shot: Shot): Promise<string | undefined> {
  const { deps, run, bot, runId } = ctx;
  const artifacts = deps.artifacts;
  if (!artifacts) return undefined;
  const mimeType = stepScreenshotMimeType(shot.mimeType);
  const stored = await artifacts.put(
    { name: STEP_FRAME_PENDING, mimeType, bytes: shot.data },
    context(ctx, `${shot.executionId}:frame`),
  );
  const hash = `frame:${runId}:${createHash("sha256").update(shot.data).digest("hex")}`;
  const written = await deps.prisma
    .$transaction(async (tx) => {
      const held = await holdStepFrame(tx, {
        spaceId: run.spaceId,
        botId: bot.id,
        bytes: shot.data.byteLength,
      });
      if (!held.allowed) return { id: undefined, removed: held.removed };
      const row = await tx.artifact.create({
        data: {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          groupId: null,
          runId,
          name: STEP_FRAME_PENDING,
          mimeType,
          size: shot.data.byteLength,
          hash,
          storageKey: stored.id,
        },
        select: { id: true },
      });
      return { id: row.id, removed: held.removed };
    })
    .catch(async (error) => {
      await removeFiles(ctx, [{ storageKey: stored.id }]);
      throw error;
    });
  const unused = written.id ? [] : [{ storageKey: stored.id }];
  await removeFiles(ctx, [...written.removed, ...unused]);
  return written.id;
}

/** Writes the frame when its turn comes, unless it was dropped, the reply ended or has no room. */
async function writeInTurn(ctx: RunContext, state: Frames, frame: Frame, shot: Shot) {
  if (state.closed || frame.dropped) return;
  if (state.room === undefined) state.room = await stepFrameRoom(ctx.deps.prisma, ctx.run.spaceId);
  if (state.room !== null && state.room < shot.data.byteLength) return;
  frame.artifactId = await writeFrame(ctx, shot);
  if (!frame.artifactId) {
    // Refused: read the room again once, then stop writing for this reply.
    state.room = state.refreshed ? 0 : undefined;
    state.refreshed = true;
    return;
  }
  if (typeof state.room === "number") state.room -= shot.data.byteLength;
  if (!state.closed && !frame.dropped) link(ctx, frame);
}

/**
 * Every screenshot the reply took since the last call becomes a candidate frame. Frames are kept
 * at an even spread that grows as the reply does: past the limit, every other one goes and only
 * every second one after it is taken, so the first stays and the last is the reply's own. A frame
 * dropped before its turn to be written is never written.
 */
export function noteScreenshot(ctx: RunContext) {
  const shot = ctx.state.reply.latestScreenshot;
  if (!shot) return;
  const state = framesOf(ctx);
  if (!state.eligible || state.closed || state.seen === shot.data) return;
  state.seen = shot.data;
  const ordinal = state.count++;
  if (ordinal % state.stride !== 0) return;
  const frame: Frame = { executionId: shot.executionId, ordinal, dropped: false };
  state.frames.push(frame);
  state.writer = state.writer.then(() =>
    bestEffort("keep a reply's step frame", writeInTurn(ctx, state, frame, shot)).then(
      () => undefined,
    ),
  );
  while (state.frames.filter((kept) => !kept.dropped).length > STEP_FRAMES_MAX - 1) {
    state.stride *= 2;
    for (const kept of state.frames)
      if (!kept.dropped && kept.ordinal % state.stride !== 0) {
        kept.dropped = true;
        unlink(ctx, kept);
      }
  }
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

/** Once the last write is done: keeps the frames the reply links, removes the run's others. */
async function settle(ctx: RunContext, state: Frames) {
  await state.writer;
  const linked = [...ctx.state.reply.toolStepCalls.values()].flatMap((call) =>
    call.image ? [call.image.artifactId] : [],
  );
  const removed = await settleStepFrames(ctx.deps.prisma, {
    spaceId: ctx.run.spaceId,
    botId: ctx.bot.id,
    runId: ctx.runId,
    linked,
  });
  await removeFiles(ctx, removed);
}

/**
 * Saves the reply's last screenshot as before, then keeps the frames already written beside it.
 * Frames not written yet are left out, so the reply never waits for one. Without its last
 * screenshot the reply keeps none of the others, as before: the bot's next run reads the newest
 * one kept as what is on the screen now. A pending frame of a run that ends any other way (failed,
 * cancelled, handed back for good) is removed by the bot's next frame write.
 */
export async function saveLatestStepScreenshot(ctx: RunContext): Promise<void> {
  const state = framesOf(ctx);
  state.closed = true;
  const last = ctx.state.reply.latestScreenshot?.executionId;
  // The last screenshot is the upstream save's to keep or lose, as before.
  for (const frame of state.frames) if (frame.executionId === last) unlink(ctx, frame);
  await upstreamSaveLatest(ctx);
  if (!state.eligible) return;
  const lastKept = last ? ctx.state.reply.toolStepCalls.get(last)?.image : undefined;
  if (last && !lastKept) for (const frame of state.frames) unlink(ctx, frame);
  capFrames(ctx);
  void bestEffort("settle a reply's replay frames", settle(ctx, state));
}
