import type { RelayWebTypes } from "@rakazo/core";

/**
 * The `Request` and `Response` the relay client builds on. React Native's own come from a fetch
 * polyfill that cannot hold a stream body, and the relay streams every body, the live event stream
 * included. These two do only that: a body as a `ReadableStream`, read once, plus the reading
 * methods the app uses. A multipart upload (React Native's `FormData` of file URIs) cannot cross
 * the relay: the native layer reads those files, not JavaScript.
 */

const encoder = new TextEncoder();

export class RelayUnsupportedBodyError extends TypeError {
  override name = "RelayUnsupportedBodyError";
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A request body as a stream, and the content type the body implies. */
function requestBody(body: unknown): { stream: ReadableStream<Uint8Array> | null; type?: string } {
  if (body === undefined || body === null) return { stream: null };
  if (typeof body === "string") {
    return { stream: streamOf(encoder.encode(body)), type: "text/plain;charset=UTF-8" };
  }
  if (body instanceof URLSearchParams) {
    return {
      stream: streamOf(encoder.encode(body.toString())),
      type: "application/x-www-form-urlencoded;charset=UTF-8",
    };
  }
  if (body instanceof ArrayBuffer) return { stream: streamOf(new Uint8Array(body.slice(0))) };
  if (ArrayBuffer.isView(body)) {
    return {
      stream: streamOf(
        new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
      ),
    };
  }
  if (body instanceof ReadableStream) return { stream: body };
  throw new RelayUnsupportedBodyError("this body cannot be sent through the relay");
}

export class RelayRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly signal: AbortSignal;
  readonly body: ReadableStream<Uint8Array> | null;

  constructor(url: string, init: RequestInit = {}) {
    this.url = url;
    this.method = (init.method ?? "GET").toUpperCase();
    this.headers = new Headers(init.headers);
    this.signal = init.signal ?? new AbortController().signal;
    const { stream, type } = requestBody(init.body);
    if (stream && (this.method === "GET" || this.method === "HEAD")) {
      throw new TypeError(`a ${this.method} request cannot have a body`);
    }
    if (type && !this.headers.has("content-type")) this.headers.set("content-type", type);
    this.body = stream;
  }
}

export class RelayResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly ok: boolean;
  readonly url = "";
  readonly redirected = false;
  readonly type = "basic";
  private stream: ReadableStream<Uint8Array> | null;
  private used = false;

  constructor(
    body: ReadableStream<Uint8Array> | null,
    init: { status?: number; statusText?: string; headers?: HeadersInit } = {},
  ) {
    const status = init.status ?? 200;
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      throw new RangeError(`invalid status ${status}`);
    }
    this.status = status;
    this.statusText = init.statusText ?? "";
    this.headers = new Headers(init.headers);
    this.ok = status < 300;
    this.stream = body;
  }

  get body() {
    return this.stream;
  }

  get bodyUsed() {
    return this.used;
  }

  async bytes(): Promise<Uint8Array> {
    if (this.used) throw new TypeError("body already read");
    this.used = true;
    if (!this.stream) return new Uint8Array(0);
    const reader = this.stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.bytes();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async text() {
    return new TextDecoder().decode(await this.bytes());
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  async blob(): Promise<Blob> {
    throw new RelayUnsupportedBodyError("a file download cannot be read through the relay");
  }

  async formData(): Promise<FormData> {
    throw new RelayUnsupportedBodyError("a form body cannot be read through the relay");
  }

  clone(): RelayResponse {
    if (this.used) throw new TypeError("body already read");
    let copy: ReadableStream<Uint8Array> | null = null;
    if (this.stream) [this.stream, copy] = this.stream.tee();
    return new RelayResponse(copy, {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
    });
  }
}

/** For `relayClient`: the two classes stand in for the platform's where the relay needs them. */
export const relayWebTypes = {
  Request: RelayRequest,
  Response: RelayResponse,
} as unknown as RelayWebTypes;
