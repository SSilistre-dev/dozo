import type { RelayRequestHead, RelayResponseHead } from "@rakazo/contracts";
import {
  RELAY_FRAME_HEADER_BYTES,
  RELAY_MAX_FRAME_PAYLOAD,
  RELAY_MAX_RECORD_PLAINTEXT,
  RELAY_MAX_REQUEST_BODY,
  RELAY_MAX_STREAMS,
  RELAY_STREAM_WINDOW,
  RelayFrameType,
  RelayRequestHeadSchema,
  RelayResponseHeadSchema,
} from "@rakazo/contracts";
import type { RelayDuplex } from "./dozo-relay-channel.js";

/**
 * HTTP requests and streamed responses over one relay channel: `relayClient` on the phone gives a
 * `fetch` that returns streaming `Response`s, `serveRelay` on the computer forwards each request to
 * a loopback server. Frames, flow control and limits: `dozo/relay/PROTOCOL.md`.
 */

export class RelayMuxError extends Error {
  override name = "RelayMuxError";
}

/** The origin the client's `Request`s are built on; only the path and query cross the channel. */
const CLIENT_BASE = "http://relay.invalid";
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
/** Headers about one hop's connection, never carried across the channel. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
]);
/** The loopback client already decoded and re-chunked the body, so these no longer describe it. */
const BODY_HEADERS = new Set(["content-encoding", "content-length"]);

type Frame = { type: number; stream: number; payload: Uint8Array };

/** Runs after the current event-loop turn: `setImmediate` where the runtime has it (Node). */
const nextTurn: (callback: () => void) => unknown =
  (globalThis as { setImmediate?: (callback: () => void) => unknown }).setImmediate ??
  ((callback) => setTimeout(callback, 0));

/** Writes one frame: type, stream id, payload length, payload. */
export function encodeRelayFrame(
  type: number,
  stream: number,
  payload: Uint8Array = new Uint8Array(0),
) {
  if (payload.length > RELAY_MAX_FRAME_PAYLOAD) throw new RelayMuxError("frame too large");
  const frame = new Uint8Array(RELAY_FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, type);
  view.setUint32(1, stream);
  view.setUint16(5, payload.length);
  frame.set(payload, RELAY_FRAME_HEADER_BYTES);
  return frame;
}

/** Reads every frame of a record; throws on a truncated or oversized one. */
export function decodeRelayFrames(record: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  let offset = 0;
  while (offset < record.length) {
    if (record.length - offset < RELAY_FRAME_HEADER_BYTES)
      throw new RelayMuxError("truncated frame");
    const length = view.getUint16(offset + 5);
    const end = offset + RELAY_FRAME_HEADER_BYTES + length;
    if (length > RELAY_MAX_FRAME_PAYLOAD || end > record.length)
      throw new RelayMuxError("truncated frame");
    frames.push({
      type: view.getUint8(offset),
      stream: view.getUint32(offset + 1),
      payload: record.subarray(offset + RELAY_FRAME_HEADER_BYTES, end),
    });
    offset = end;
  }
  return frames;
}

/** A stream's sending half: body bytes may go out only while the reader has granted credit. */
class Credit {
  private credit = RELAY_STREAM_WINDOW;
  private waiting: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;

  async take(wanted: number) {
    while (this.credit === 0 && !this.failure) {
      await new Promise<void>((resolve, reject) => {
        this.waiting = { resolve, reject };
      });
    }
    if (this.failure) throw this.failure;
    const size = Math.min(wanted, this.credit);
    this.credit -= size;
    return size;
  }

  grant(bytes: number) {
    this.credit += bytes;
    this.waiting?.resolve();
    this.waiting = null;
  }

  fail(error: Error) {
    this.failure ??= error;
    this.waiting?.reject(error);
    this.waiting = null;
  }
}

/** A stream's receiving half: a byte stream that grants credit back as its reader consumes it. */
class Inbox {
  readonly body: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private granted = RELAY_STREAM_WINDOW;
  private received = 0;
  private done = false;

  constructor(grant: (bytes: number) => void, cancel: () => void) {
    this.body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        pull: () => {
          // Not called once the stream closed or errored, so the size is a number here.
          const buffered = RELAY_STREAM_WINDOW - (this.controller.desiredSize as number);
          const more = RELAY_STREAM_WINDOW - buffered - (this.granted - this.received);
          if (more < RELAY_STREAM_WINDOW / 4) return;
          this.granted += more;
          grant(more);
        },
        cancel: () => {
          this.done = true;
          cancel();
        },
      },
      { highWaterMark: RELAY_STREAM_WINDOW, size: (chunk) => chunk.byteLength },
    );
  }

  /** False when the sender went past its credit. */
  push(bytes: Uint8Array) {
    if (this.done) return true;
    this.received += bytes.length;
    if (this.received > this.granted) return false;
    this.controller.enqueue(bytes.slice());
    return true;
  }

  end() {
    if (this.done) return;
    this.done = true;
    this.controller.close();
  }

  fail(error: Error) {
    if (this.done) return;
    this.done = true;
    this.controller.error(error);
  }
}

type Stream = {
  credit: Credit;
  inbox: Inbox | null;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  /** Most body bytes the other end may send on this stream. */
  limit: number;
  /** Runs after the incoming body ended. */
  ended: () => void;
  /** Ends the stream locally; `notify` also tells the other end. */
  finish(error: Error | null, notify: boolean): void;
};

abstract class Mux {
  protected readonly streams = new Map<number, Stream>();
  protected failure: Error | null = null;
  private queue: Uint8Array[] = [];
  private flushing = false;

  constructor(protected readonly duplex: RelayDuplex) {
    duplex.attach({
      receive: (record) => this.onRecord(record),
      closed: (error) => this.shutdown(error),
    });
  }

  close(reason = "closed") {
    this.duplex.close(reason);
    this.shutdown(new RelayMuxError(reason));
  }

  protected abstract onOpen(frame: Frame): void;
  protected abstract onHead(stream: Stream, frame: Frame): void;

  /** When frames written now are sent: after the promise callbacks of this turn by default. */
  protected schedule(flush: () => void) {
    queueMicrotask(flush);
  }

  /** Frames written in the same turn share records, up to the record limit. */
  protected write(frame: Uint8Array) {
    this.queue.push(frame);
    if (this.flushing) return;
    this.flushing = true;
    this.schedule(() => {
      this.flushing = false;
      let record: Uint8Array[] = [];
      let size = 0;
      for (const next of this.queue.splice(0)) {
        if (size + next.length > RELAY_MAX_RECORD_PLAINTEXT) {
          this.duplex.send(join(record, size));
          record = [];
          size = 0;
        }
        record.push(next);
        size += next.length;
      }
      this.duplex.send(join(record, size));
    });
  }

  protected cancel(id: number, reason: string) {
    this.write(
      encodeRelayFrame(RelayFrameType.cancel, id, new TextEncoder().encode(reason.slice(0, 256))),
    );
  }

  /** Sends a body as `data` frames within the stream's credit, then `end`; or `cancel` on failure. */
  protected async pump(
    id: number,
    stream: Stream,
    body: ReadableStream<Uint8Array>,
    onEnd: () => void,
  ) {
    const reader = body.getReader();
    stream.reader = reader;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.length; ) {
          const size = await stream.credit.take(
            Math.min(value.length - offset, RELAY_MAX_FRAME_PAYLOAD),
          );
          this.write(
            encodeRelayFrame(RelayFrameType.data, id, value.subarray(offset, offset + size)),
          );
          offset += size;
        }
      }
      this.write(encodeRelayFrame(RelayFrameType.end, id));
      onEnd();
    } catch (error) {
      void reader.cancel(error).catch(() => undefined);
      stream.finish(new RelayMuxError(`body failed: ${message(error)}`), true);
    }
  }

  /** Forgets a stream; false when it had already ended, so ending it again does nothing. */
  protected release(id: number, stream: Stream) {
    if (this.streams.get(id) !== stream) return false;
    this.streams.delete(id);
    return true;
  }

  protected inbox(id: number, stream: Stream) {
    return new Inbox(
      (bytes) => {
        const payload = new Uint8Array(4);
        new DataView(payload.buffer).setUint32(0, bytes);
        this.write(encodeRelayFrame(RelayFrameType.window, id, payload));
      },
      () => stream.finish(new RelayMuxError("body cancelled"), true),
    );
  }

  private onRecord(record: Uint8Array) {
    if (this.failure) return;
    let frames: Frame[];
    try {
      frames = decodeRelayFrames(record);
    } catch (error) {
      this.close(message(error));
      return;
    }
    for (const frame of frames) this.onFrame(frame);
  }

  private onFrame(frame: Frame) {
    if (frame.type === RelayFrameType.request) return this.onOpen(frame);
    const stream = this.streams.get(frame.stream);
    // A frame for a stream that already ended crossed the end on the way: nothing to do.
    if (!stream) return;
    switch (frame.type) {
      case RelayFrameType.response:
        return this.onHead(stream, frame);
      case RelayFrameType.data:
        stream.limit -= frame.payload.length;
        if (stream.limit < 0) return stream.finish(new RelayMuxError("body too large"), true);
        if (!stream.inbox?.push(frame.payload))
          stream.finish(new RelayMuxError("flow control violated"), true);
        return;
      case RelayFrameType.end:
        stream.inbox?.end();
        return stream.ended();
      case RelayFrameType.cancel:
        return stream.finish(
          new RelayMuxError(`cancelled by peer: ${new TextDecoder().decode(frame.payload)}`),
          false,
        );
      case RelayFrameType.window:
        if (frame.payload.length === 4)
          stream.credit.grant(
            new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint32(0),
          );
        return;
      default:
        return stream.finish(new RelayMuxError(`unknown frame type ${frame.type}`), true);
    }
  }

  private shutdown(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const stream of [...this.streams.values()]) stream.finish(error, false);
  }
}

export type RelayClient = {
  /** Works like `fetch`: only the path and query of `input` are sent; the response body streams. */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  close(reason?: string): void;
};

/** The phone's end of the multiplexer. */
export function relayClient(duplex: RelayDuplex): RelayClient {
  const client = new ClientMux(duplex);
  return {
    fetch: (input, init) => client.fetch(input, init),
    close: (reason) => client.close(reason),
  };
}

class ClientMux extends Mux {
  private nextId = 1;
  private readonly waiting = new Map<
    number,
    { resolve: (response: Response) => void; method: string }
  >();

  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const target = new URL(input, CLIENT_BASE);
    const path = target.pathname + target.search;
    // Request normalizes every body type to a stream and fills in its content type.
    const request = new Request(CLIENT_BASE + path, { ...init, duplex: "half" } as RequestInit);
    request.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.streams.size >= RELAY_MAX_STREAMS) throw new RelayMuxError("too many open requests");
    const head: RelayRequestHead = {
      method: request.method,
      path,
      headers: [...request.headers],
      body: Boolean(request.body),
    };
    const payload = new TextEncoder().encode(JSON.stringify(head));
    if (payload.length > RELAY_MAX_FRAME_PAYLOAD) throw new RelayMuxError("request head too large");

    const id = this.nextId++;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => stream.finish(abortReason(request.signal), true);
      const stream: Stream = {
        credit: new Credit(),
        inbox: null,
        reader: null,
        limit: Number.POSITIVE_INFINITY,
        // The stream is done once the response body ends; the request body needs no more credit.
        ended: () =>
          stream.finish(stream.inbox ? null : new RelayMuxError("ended before a response"), true),
        finish: (error, notify) => {
          if (!this.release(id, stream)) return;
          this.waiting.delete(id);
          request.signal.removeEventListener("abort", onAbort);
          stream.credit.fail(error ?? new RelayMuxError("stream ended"));
          void stream.reader?.cancel().catch(() => undefined);
          if (error) {
            if (notify) this.cancel(id, error.message);
            stream.inbox?.fail(error);
            reject(error);
          }
        },
      };
      this.streams.set(id, stream);
      this.waiting.set(id, { resolve, method: request.method });
      request.signal.addEventListener("abort", onAbort);
      this.write(encodeRelayFrame(RelayFrameType.request, id, payload));
      if (request.body) void this.pump(id, stream, request.body, () => undefined);
      else this.write(encodeRelayFrame(RelayFrameType.end, id));
    });
  }

  protected onOpen(frame: Frame) {
    this.close(`unexpected request frame on stream ${frame.stream}`);
  }

  protected onHead(stream: Stream, frame: Frame) {
    const waiting = this.waiting.get(frame.stream);
    const head = parseJson(RelayResponseHeadSchema, frame.payload);
    if (!waiting || !head) return stream.finish(new RelayMuxError("bad response head"), true);
    const inbox = this.inbox(frame.stream, stream);
    const nullBody = NULL_BODY_STATUSES.has(head.status) || waiting.method === "HEAD";
    let response: Response;
    try {
      response = new Response(nullBody ? null : inbox.body, {
        status: head.status,
        statusText: head.statusText,
        headers: head.headers,
      });
    } catch {
      return stream.finish(new RelayMuxError("bad response head"), true);
    }
    this.waiting.delete(frame.stream);
    stream.inbox = inbox;
    waiting.resolve(response);
  }
}

export type RelayServeOptions = {
  /** The loopback origin requests are forwarded to, such as `http://127.0.0.1:3000`. */
  origin: string;
  /** Sends one request to that origin; normally `fetch`. */
  forward: (request: Request) => Promise<Response>;
  maxRequestBody?: number;
};

/** The computer's end of the multiplexer. */
export function serveRelay(duplex: RelayDuplex, options: RelayServeOptions) {
  const server = new ServerMux(duplex, options);
  return { close: (reason?: string) => server.close(reason) };
}

class ServerMux extends Mux {
  private readonly origin: string;

  constructor(
    duplex: RelayDuplex,
    private readonly options: RelayServeOptions,
  ) {
    super(duplex);
    this.origin = new URL(options.origin).origin;
  }

  /**
   * After the whole event-loop turn instead: the loopback client hands over a small response's
   * head, body and end in one turn but through several promise hops, so they share one record
   * (one relay message instead of three). Nothing waits on a timer, so a stream's events still go
   * out as soon as they are read.
   */
  protected override schedule(flush: () => void) {
    nextTurn(flush);
  }

  protected onHead(stream: Stream) {
    stream.finish(new RelayMuxError("unexpected response frame"), true);
  }

  /** The path on the loopback origin, or null when it would leave it or does not parse. */
  private resolve(path: string) {
    try {
      const url = new URL(path, this.origin);
      return url.origin === this.origin ? url : null;
    } catch {
      return null;
    }
  }

  protected onOpen(frame: Frame) {
    const id = frame.stream;
    if (this.streams.has(id) || id === 0) return this.close(`stream ${id} reused`);
    if (this.streams.size >= RELAY_MAX_STREAMS) return this.cancel(id, "too many open requests");
    const head = parseJson(RelayRequestHeadSchema, frame.payload);
    const url = head && this.resolve(head.path);
    if (!head || !url) return this.cancel(id, "bad request");

    const abort = new AbortController();
    const stream: Stream = {
      credit: new Credit(),
      inbox: null,
      reader: null,
      limit: this.options.maxRequestBody ?? RELAY_MAX_REQUEST_BODY,
      ended: () => undefined,
      finish: (error, notify) => {
        if (!this.release(id, stream)) return;
        // A response may finish before its request body did: that body is not read any more.
        const reason = error ?? new RelayMuxError("response finished");
        stream.credit.fail(reason);
        stream.inbox?.fail(reason);
        if (!error) return;
        if (notify) this.cancel(id, error.message);
        abort.abort(error);
        void stream.reader?.cancel(error).catch(() => undefined);
      },
    };
    this.streams.set(id, stream);
    const inbox = head.body ? this.inbox(id, stream) : null;
    stream.inbox = inbox;

    let request: Request;
    try {
      request = new Request(url, {
        method: head.method,
        // The body is streamed again on this side, so its length is the loopback client's to set.
        headers: head.headers.filter(
          ([name]) =>
            !HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "content-length",
        ),
        body: inbox?.body ?? null,
        signal: abort.signal,
        duplex: "half",
      } as RequestInit);
    } catch {
      return stream.finish(new RelayMuxError("bad request"), true);
    }
    Promise.resolve()
      .then(() => this.options.forward(request))
      .then(
        (response) => {
          if (this.streams.get(id) !== stream)
            return void response.body?.cancel().catch(() => undefined);
          const head: RelayResponseHead = {
            status: response.status,
            statusText: response.statusText,
            headers: [...response.headers].filter(
              ([name]) => !HOP_HEADERS.has(name) && !BODY_HEADERS.has(name),
            ),
          };
          const payload = new TextEncoder().encode(JSON.stringify(head));
          if (payload.length > RELAY_MAX_FRAME_PAYLOAD) {
            void response.body?.cancel().catch(() => undefined);
            return stream.finish(new RelayMuxError("response head too large"), true);
          }
          this.write(encodeRelayFrame(RelayFrameType.response, id, payload));
          const done = () => stream.finish(null, false);
          if (response.body) void this.pump(id, stream, response.body, done);
          else {
            this.write(encodeRelayFrame(RelayFrameType.end, id));
            done();
          }
        },
        (error) => stream.finish(new RelayMuxError(`forward failed: ${message(error)}`), true),
      );
  }
}

function parseJson<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  bytes: Uint8Array,
) {
  try {
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? (parsed.data as T) : null;
  } catch {
    return null;
  }
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new RelayMuxError("aborted");
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function join(parts: Uint8Array[], size: number) {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
