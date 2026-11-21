import type { ProductEvent } from "@rakazo/contracts";
import { MessageBlock } from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import * as z from "zod";
import { messageBody } from "./dozo-chat-markdown.js";

/** Where a run stands when its stream ends: done, stopped for the person, or still going. */
export type DozoRunStreamStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_input"
  | "waiting_takeover"
  | "running";

/** Run statuses that end a stream at once: nothing more will come until the person acts. */
export const DOZO_SETTLED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "waiting_input",
  "waiting_takeover",
]);

export type DozoStreamFrame = {
  /** The event's sequence number, so a client resumes after it with `Last-Event-ID`. */
  id?: number;
  event: "run" | "delta" | "activity" | "message" | "status";
  data: Record<string, unknown>;
};

const ENDING_EVENTS: Partial<Record<ProductEvent["type"], DozoRunStreamStatus>> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  // An approval or a question waits for the person in the app; the call does not.
  "run.waiting_input": "waiting_input",
  "computer.takeover.requested": "waiting_takeover",
};

const BotMessagePayload = z.object({
  messageId: z.string(),
  role: z.literal("bot"),
  blocks: z.array(z.unknown()),
});

/**
 * What one thread event means for a client following one run, or nothing when it is not about
 * that run or not something a client shows. Text streams as `delta`; a finished bot message
 * comes whole as `message`; the run's end, or a stop for the person, is the last frame.
 */
export function dozoStreamFrame(event: ProductEvent, runId: string): DozoStreamFrame | null {
  if (event.runId !== runId) return null;
  const id = event.seq;
  const ending = ENDING_EVENTS[event.type];
  if (ending) return { id, event: "status", data: { status: ending } };
  if (event.type === "thread.progress") {
    const { delta, text, streaming, activity } = event.payload;
    if (typeof delta === "string") return { id, event: "delta", data: { text: delta } };
    if (typeof text !== "string") return null;
    // The first streamed piece arrives whole; a line without streaming is the bot's working note.
    if (streaming === true && activity !== true) return { id, event: "delta", data: { text } };
    return { id, event: "activity", data: { text } };
  }
  if (event.type === "thread.message.created") {
    const parsed = BotMessagePayload.safeParse(event.payload);
    if (!parsed.success) return null;
    const blocks = parsed.data.blocks.flatMap((block) => {
      const one = MessageBlock.safeParse(block);
      return one.success ? [one.data] : [];
    });
    const text = messageBody({ role: "bot", blocks });
    if (!text) return null;
    return { id, event: "message", data: { id: parsed.data.messageId, text } };
  }
  return null;
}

/** One frame in `text/event-stream` form. Data is one JSON line, so it never needs splitting. */
export function sseFrame(frame: DozoStreamFrame): string {
  const id = frame.id === undefined ? "" : `id: ${frame.id}\n`;
  return `${id}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** What a stream may hold for a reader that stopped reading before it ends. */
export const DOZO_STREAM_MAX_QUEUED_BYTES = 1024 * 1024;

/** A comment line: proxies and clients see the stream is alive. */
export const SSE_KEEPALIVE = ": keepalive\n\n";

export type DozoRunEvents = AsyncIterable<ProductEvent>;

/** A run that had already settled when the stream opened, and the thread's last event then. */
export type DozoSettledRun = { status: string; headSeq: number };

/**
 * Streams one run's frames as server-sent events, starting with `first` frames, until the run ends
 * or stops for the person, the events end, the client leaves, or `maxMs` passes, when a last
 * `status: running` frame tells the client to resume from the last id it saw.
 */
export function dozoRunStream(input: {
  runId: string;
  /** Bytes the stream may hold for a reader that does not read; past it, it ends. */
  maxQueuedBytes?: number;
  events: (signal: AbortSignal) => DozoRunEvents;
  first?: DozoStreamFrame[];
  /** Replay up to `headSeq`, then end with this status instead of waiting for more. */
  settled?: DozoSettledRun;
  signal: AbortSignal;
  maxMs: number;
  onClose?: () => void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const cancelled = new AbortController();
  const deadline = deadlineSignal(input.maxMs);
  const signal = AbortSignal.any([input.signal, cancelled.signal, deadline]);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    input.onClose?.();
  };
  const maxQueued = input.maxQueuedBytes ?? DOZO_STREAM_MAX_QUEUED_BYTES;
  return new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        const send = (text: string) => controller.enqueue(encoder.encode(text));
        let ended = false;
        try {
          for (const frame of input.first ?? []) send(sseFrame(frame));
          const { settled } = input;
          for await (const event of input.events(signal)) {
            if (signal.aborted) break;
            const frame = event.type === "heartbeat" ? null : dozoStreamFrame(event, input.runId);
            if (frame) send(sseFrame(frame));
            if (frame?.event === "status") {
              ended = true;
              break;
            }
            // Replayed up to where the settled run's thread stood: nothing more is coming.
            if (settled && (event.type === "heartbeat" || event.seq >= settled.headSeq)) {
              send(sseFrame({ event: "status", data: { status: settled.status } }));
              ended = true;
              break;
            }
            if (event.type === "heartbeat") send(SSE_KEEPALIVE);
            // A reader that stopped reading is not queued for without end: the stream ends and the
            // client follows the run again from the last id it read.
            if ((controller.desiredSize ?? 0) < -maxQueued) break;
          }
        } catch (error) {
          // The client left or the time ran out; anything else ends the stream as an error.
          if (!signal.aborted) {
            close();
            controller.error(error);
            return;
          }
        }
        close();
        if (input.signal.aborted || cancelled.signal.aborted) return;
        if (!ended) send(sseFrame({ event: "status", data: { status: "running" } }));
        controller.close();
      },
      cancel() {
        cancelled.abort();
        close();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
  );
}
