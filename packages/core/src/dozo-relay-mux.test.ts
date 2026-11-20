import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  RELAY_FRAME_HEADER_BYTES,
  RELAY_MAX_FRAME_PAYLOAD,
  RELAY_MAX_STREAMS,
  RELAY_RECORD_OVERHEAD,
  RELAY_STREAM_WINDOW,
  RelayFrameType,
} from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, flush } from "./async.test-support.js";
import { containsBytes, relayPipe } from "./dozo-relay.test-support.js";
import {
  acceptHostChannel,
  encodeRelayBytes,
  openAppChannel,
  relayPairingSecrets,
  webRelayCrypto,
} from "./dozo-relay-channel.js";
import { decodeRelayFrames, encodeRelayFrame, relayClient, serveRelay } from "./dozo-relay-mux.js";

const ORIGIN = "http://127.0.0.1:3000";
const text = (value: string) => new TextEncoder().encode(value);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A client and a server over an unsealed pipe; `forward` answers in place of a loopback server. */
function setup(forward: (request: Request) => Promise<Response>, maxRequestBody?: number) {
  const pipe = relayPipe();
  const server = serveRelay(pipe.host, { origin: ORIGIN, forward, maxRequestBody });
  const client = relayClient(pipe.app);
  cleanups.push(() => client.close());
  return { pipe, server, client };
}

/** A body the test feeds chunk by chunk, and whether its reader cancelled it. */
function controlledBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = deferred<unknown>();
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
    cancel: (reason) => cancelled.resolve(reason),
  });
  return { body, controller, cancelled };
}

function frames(pipe: ReturnType<typeof relayPipe>, from: "app" | "host") {
  return pipe.log
    .filter((entry) => entry.from === from)
    .flatMap((entry) => decodeRelayFrames(entry.data));
}

describe("relay frames", () => {
  it("packs and reads frames", () => {
    const record = new Uint8Array([
      ...encodeRelayFrame(RelayFrameType.data, 7, text("abc")),
      ...encodeRelayFrame(RelayFrameType.end, 7),
    ]);
    expect(decodeRelayFrames(record)).toEqual([
      { type: RelayFrameType.data, stream: 7, payload: text("abc") },
      { type: RelayFrameType.end, stream: 7, payload: new Uint8Array(0) },
    ]);
    expect(() => decodeRelayFrames(record.subarray(0, 8))).toThrow("truncated frame");
    expect(() => decodeRelayFrames(record.subarray(0, 3))).toThrow("truncated frame");
    expect(() =>
      encodeRelayFrame(RelayFrameType.data, 1, new Uint8Array(RELAY_MAX_FRAME_PAYLOAD + 1)),
    ).toThrow("frame too large");
    const oversized = encodeRelayFrame(RelayFrameType.data, 1);
    new DataView(oversized.buffer).setUint16(5, RELAY_MAX_FRAME_PAYLOAD + 1);
    expect(() =>
      decodeRelayFrames(
        new Uint8Array([...oversized, ...new Uint8Array(RELAY_MAX_FRAME_PAYLOAD + 1)]),
      ),
    ).toThrow("truncated frame");
  });
});

describe("relay multiplexer", () => {
  it("forwards a request to the origin and returns the response", async () => {
    const forward = vi.fn(async (request: Request) => {
      expect(request.url).toBe(`${ORIGIN}/api/bots?limit=2`);
      expect(request.headers.get("authorization")).toBe("Bearer placeholder");
      return new Response("hello", {
        status: 201,
        statusText: "Created",
        headers: { "x-kind": "test", "content-encoding": "gzip", "content-length": "99" },
      });
    });
    const { client } = setup(forward);
    const response = await client.fetch("https://server.example/api/bots?limit=2", {
      headers: { authorization: "Bearer placeholder" },
    });
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-kind")).toBe("test");
    // The body arrives decoded and re-chunked, so its old encoding and length are dropped.
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.text()).toBe("hello");
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("streams a large request body within the window and echoes it", async () => {
    const { client, pipe } = setup(async (request) => new Response(await request.arrayBuffer()));
    const body = Uint8Array.from({ length: 1024 * 1024 + 5 }, (_, index) => index % 251);
    const response = await client.fetch("/upload", { method: "POST", body });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect(frames(pipe, "host").some((frame) => frame.type === RelayFrameType.window)).toBe(true);
    expect(frames(pipe, "app").some((frame) => frame.type === RelayFrameType.window)).toBe(true);
  });

  it("serves many requests at once on one channel", async () => {
    const { client, pipe } = setup(async (request) => {
      await flush();
      return new Response(new URL(request.url).searchParams.get("n"));
    });
    const answers = await Promise.all(
      Array.from({ length: 40 }, (_, n) =>
        client.fetch(`/echo?n=${n}`).then((response) => response.text()),
      ),
    );
    expect(answers).toEqual(Array.from({ length: 40 }, (_, n) => String(n)));
    // Requests written in the same turn share one record.
    expect(pipe.log.filter((entry) => entry.from === "app")[0]?.data.length).toBeGreaterThan(
      40 * RELAY_FRAME_HEADER_BYTES,
    );
  });

  it("streams a response chunk by chunk and stops the server when the reader cancels", async () => {
    const events = controlledBody();
    const { client } = setup(
      async () => new Response(events.body, { headers: { "content-type": "text/event-stream" } }),
    );
    const response = await client.fetch("/api/stream");
    const reader = response.body?.getReader();
    events.controller.enqueue(text("data: one\n\n"));
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: one\n\n");
    events.controller.enqueue(text("data: two\n\n"));
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: two\n\n");
    await reader?.cancel();
    await expect(events.cancelled.promise).resolves.toBeInstanceOf(Error);
  });

  it("holds a response at the window until the reader catches up", async () => {
    const events = controlledBody();
    const { client, pipe } = setup(async () => new Response(events.body));
    const response = await client.fetch("/big");
    const chunk = new Uint8Array(RELAY_MAX_FRAME_PAYLOAD).fill(1);
    for (let index = 0; index < 16; index += 1) events.controller.enqueue(chunk);
    events.controller.close();
    const sentBytes = () =>
      frames(pipe, "host")
        .filter((frame) => frame.type === RelayFrameType.data)
        .reduce((sum, frame) => sum + frame.payload.length, 0);
    await vi.waitFor(() => expect(sentBytes()).toBe(RELAY_STREAM_WINDOW));
    await flush();
    expect(sentBytes()).toBe(RELAY_STREAM_WINDOW);
    expect((await response.arrayBuffer()).byteLength).toBe(16 * RELAY_MAX_FRAME_PAYLOAD);
  });

  it("cancels the forwarded request when the caller aborts", async () => {
    const started = deferred<Request>();
    const { client } = setup((request) => {
      started.resolve(request);
      return new Promise<Response>(() => undefined);
    });
    const abort = new AbortController();
    const pending = client.fetch("/slow", { signal: abort.signal });
    const request = await started.promise;
    abort.abort(new Error("user left"));
    await expect(pending).rejects.toThrow("user left");
    await vi.waitFor(() => expect(request.signal.aborted).toBe(true));
    await expect(client.fetch("/slow", { signal: abort.signal })).rejects.toThrow("user left");
  });

  it("errors a streaming body when the caller aborts mid-stream", async () => {
    const events = controlledBody();
    const { client } = setup(async () => new Response(events.body));
    const abort = new AbortController();
    const response = await client.fetch("/stream", { signal: abort.signal });
    abort.abort();
    await expect(response.text()).rejects.toThrow();
    await expect(events.cancelled.promise).resolves.toBeDefined();
  });

  it("refuses a request body over the limit", async () => {
    const seen = deferred<Request>();
    const { client } = setup(async (request) => {
      seen.resolve(request);
      return new Response(await request.arrayBuffer());
    }, 1000);
    await expect(
      client.fetch("/upload", { method: "POST", body: new Uint8Array(1001) }),
    ).rejects.toThrow("body too large");
    const response = await client.fetch("/upload", { method: "POST", body: new Uint8Array(1000) });
    expect((await response.arrayBuffer()).byteLength).toBe(1000);
  });

  it("splits frames written together over the record limit", async () => {
    const records: Uint8Array[] = [];
    const client = relayClient({
      send: (data) => records.push(data),
      close: () => undefined,
      attach: () => undefined,
    });
    const headers = Object.fromEntries(
      Array.from({ length: 3 }, (_, n) => [`x-part-${n}`, "a".repeat(8000)]),
    );
    for (let n = 0; n < 3; n += 1)
      void client.fetch(`/part/${n}`, { headers }).catch(() => undefined);
    await flush();
    expect(records).toHaveLength(2);
    expect(records.flatMap((record) => decodeRelayFrames(record))).toHaveLength(6);
    client.close();
  });

  it("sends a small loopback response as one record, and a stream's head and events at once", async () => {
    const live = deferred<ServerResponse>();
    const http = createServer((request, response) => {
      if (request.url === "/api/live") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        live.resolve(response);
        return;
      }
      response.end(JSON.stringify({ bots: [] }));
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    cleanups.push(() => {
      http.closeAllConnections();
      http.close();
    });
    const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const pipe = relayPipe();
    serveRelay(pipe.host, { origin, forward: (request) => fetch(request) });
    const client = relayClient(pipe.app);
    cleanups.push(() => client.close());
    const fromHost = () => pipe.log.filter((entry) => entry.from === "host");

    // The head, body and end the loopback server wrote at once leave as one relay message.
    const before = fromHost().length;
    const response = await client.fetch("/api/bots");
    expect(await response.json()).toEqual({ bots: [] });
    expect(fromHost().length - before).toBe(1);

    // A stream's head goes out without waiting for an event, and each event without the next one.
    const opened = fromHost().length;
    const stream = await client.fetch("/api/live");
    expect(fromHost().length - opened).toBe(1);
    const reader = stream.body?.getReader();
    const server = await live.promise;
    const sent = fromHost().length;
    server.write("data: one\n\n");
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: one\n\n");
    expect(fromHost().length - sent).toBe(1);
    await reader?.cancel();
    server.end();
  });

  it("stops a response waiting for credit when the reader cancels", async () => {
    const events = controlledBody();
    const { client } = setup(async () => new Response(events.body));
    const response = await client.fetch("/big");
    for (let index = 0; index < 16; index += 1)
      events.controller.enqueue(new Uint8Array(RELAY_MAX_FRAME_PAYLOAD));
    await flush();
    await response.body?.cancel();
    await expect(events.cancelled.promise).resolves.toBeInstanceOf(Error);
  });

  it("aborts the forwarded request after its body was sent", async () => {
    const started = deferred<Request>();
    const { client } = setup(async (request) => {
      started.resolve(request);
      await request.arrayBuffer();
      return new Promise<Response>(() => undefined);
    });
    const abort = new AbortController();
    const pending = client.fetch("/upload", { method: "POST", body: "done", signal: abort.signal });
    const request = await started.promise;
    await flush();
    abort.abort("gone");
    await expect(pending).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(request.signal.aborted).toBe(true));
  });

  it("stops reading a request body once the response finished", async () => {
    const seen = deferred<Request>();
    const { client } = setup(async (request) => {
      seen.resolve(request);
      return new Response("early");
    });
    const body = new Uint8Array(4 * RELAY_STREAM_WINDOW);
    const response = await client.fetch("/upload", { method: "POST", body });
    expect(await response.text()).toBe("early");
    await expect((await seen.promise).arrayBuffer()).rejects.toThrow("response finished");
  });

  it("keeps every request on the origin", async () => {
    const forward = vi.fn(async (request: Request) => new Response(request.url));
    const { client } = setup(forward);
    expect(await (await client.fetch("//evil.example/steal?x=1")).text()).toBe(
      `${ORIGIN}/steal?x=1`,
    );
  });

  it("reports a failed forward and a failing body", async () => {
    const forward = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull: (controller) => controller.error(new Error("disk gone")),
          }),
        ),
    );
    forward.mockImplementationOnce(() => Promise.reject("connection refused"));
    forward.mockImplementationOnce(() => {
      throw new Error("not listening");
    });
    const { client } = setup(forward);
    await expect(client.fetch("/a")).rejects.toThrow("forward failed: connection refused");
    await expect(client.fetch("/a")).rejects.toThrow("forward failed: not listening");
    const response = await client.fetch("/b");
    await expect(response.text()).rejects.toThrow("body failed: disk gone");
  });

  it("returns no body for a no-content response and a HEAD request", async () => {
    const { client } = setup(async (request) =>
      request.method === "HEAD"
        ? new Response("ignored", { headers: { "x-size": "7" } })
        : new Response(null, { status: 204 }),
    );
    const empty = await client.fetch("/none", { method: "DELETE" });
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
    const head = await client.fetch("/thing", { method: "HEAD" });
    expect(head.headers.get("x-size")).toBe("7");
    expect(head.body).toBeNull();
  });

  it("limits open requests and the size of a head", async () => {
    const { client } = setup(() => new Promise<Response>(() => undefined));
    const headers = Object.fromEntries(
      Array.from({ length: 5 }, (_, n) => [`x-big-${n}`, "a".repeat(8000)]),
    );
    await expect(client.fetch("/big-head", { headers })).rejects.toThrow("request head too large");
    const open = Array.from({ length: RELAY_MAX_STREAMS }, (_, n) => client.fetch(`/wait/${n}`));
    await expect(client.fetch("/one-more")).rejects.toThrow("too many open requests");
    client.close("done");
    await expect(Promise.allSettled(open)).resolves.toHaveLength(RELAY_MAX_STREAMS);
    await expect(open[0]).rejects.toThrow("done");
    await expect(client.fetch("/after")).rejects.toThrow("done");
  });

  it("refuses a response head over the frame limit", async () => {
    const { client } = setup(
      async () => new Response("x", { headers: { "x-huge": "h".repeat(RELAY_MAX_FRAME_PAYLOAD) } }),
    );
    await expect(client.fetch("/huge")).rejects.toThrow("response head too large");
  });

  it("closes a stream whose peer breaks the protocol", async () => {
    const pipe = relayPipe();
    const forward = vi.fn(() => new Promise<Response>(() => undefined));
    serveRelay(pipe.host, { origin: ORIGIN, forward });
    const appSide: Uint8Array[] = [];
    let closedWith: Error | null = null;
    pipe.app.attach({
      receive: (data) => appSide.push(data),
      closed: (error) => (closedWith = error),
    });
    const head = (path: string, body = false) =>
      encodeRelayFrame(
        RelayFrameType.request,
        1,
        text(JSON.stringify({ method: "POST", path, headers: [], body })),
      );
    const cancels = () =>
      appSide
        .flatMap((record) => decodeRelayFrames(record))
        .filter((frame) => frame.type === RelayFrameType.cancel);

    const reasons = () => cancels().map((frame) => new TextDecoder().decode(frame.payload));

    // A malformed head, a path that leaves the origin, a frame type only the server sends, an
    // unknown frame type, and data past the window each end their stream.
    pipe.app.send(encodeRelayFrame(RelayFrameType.request, 1, text("{")));
    pipe.app.send(head("/\\evil.example/x"));
    pipe.app.send(head("/\\["));
    await vi.waitFor(() =>
      expect(reasons()).toEqual(["bad request", "bad request", "bad request"]),
    );
    pipe.app.send(head("/a"));
    pipe.app.send(encodeRelayFrame(RelayFrameType.response, 1, text("{}")));
    pipe.app.send(head("/b"));
    pipe.app.send(encodeRelayFrame(42, 1));
    pipe.app.send(head("/c", true));
    const chunk = encodeRelayFrame(RelayFrameType.data, 1, new Uint8Array(RELAY_MAX_FRAME_PAYLOAD));
    for (let index = 0; index <= RELAY_STREAM_WINDOW / RELAY_MAX_FRAME_PAYLOAD; index += 1)
      pipe.app.send(chunk);
    await vi.waitFor(() => expect(cancels()).toHaveLength(6));
    expect(reasons().slice(3)).toEqual([
      "unexpected response frame",
      "unknown frame type 42",
      "flow control violated",
    ]);
    // Frames for a stream that already ended are ignored; a window frame of the wrong size too.
    pipe.app.send(encodeRelayFrame(RelayFrameType.end, 1));
    pipe.app.send(head("/d"));
    pipe.app.send(encodeRelayFrame(RelayFrameType.window, 1, new Uint8Array(2)));
    await flush();
    expect(cancels()).toHaveLength(6);
    // An ended request body ignores what follows it.
    const upload = encodeRelayFrame(
      RelayFrameType.request,
      2,
      text(JSON.stringify({ method: "POST", path: "/f", headers: [], body: true })),
    );
    pipe.app.send(upload);
    pipe.app.send(encodeRelayFrame(RelayFrameType.end, 2));
    pipe.app.send(encodeRelayFrame(RelayFrameType.end, 2));
    pipe.app.send(encodeRelayFrame(RelayFrameType.data, 2, text("late")));
    await flush();
    expect(cancels()).toHaveLength(6);
    // Past the open stream limit, a request is refused.
    for (let id = 3; id < RELAY_MAX_STREAMS + 2; id += 1) {
      pipe.app.send(
        encodeRelayFrame(
          RelayFrameType.request,
          id,
          text(JSON.stringify({ method: "GET", path: "/g", headers: [], body: false })),
        ),
      );
    }
    await vi.waitFor(() => expect(reasons().at(-1)).toBe("too many open requests"));
    // Reusing an open stream id ends the whole connection.
    pipe.app.send(head("/e"));
    await vi.waitFor(() => expect(String(closedWith)).toContain("stream 1 reused"));
    expect(forward).toHaveBeenCalledTimes(4 + RELAY_MAX_STREAMS - 1);
  });

  it("closes the connection on a record it cannot read", async () => {
    const pipe = relayPipe();
    let closedWith: Error | null = null;
    pipe.app.attach({ receive: () => undefined, closed: (error) => (closedWith = error) });
    const forward = vi.fn(async () => new Response(""));
    serveRelay(pipe.host, { origin: ORIGIN, forward });
    pipe.app.send(new Uint8Array([1, 0, 0]));
    pipe.app.send(
      encodeRelayFrame(
        RelayFrameType.request,
        1,
        text(JSON.stringify({ method: "GET", path: "/", headers: [], body: false })),
      ),
    );
    await vi.waitFor(() => expect(String(closedWith)).toContain("truncated frame"));
    pipe.app.send(new Uint8Array([1]));
    expect(forward).not.toHaveBeenCalled();
  });

  it("closes a client that receives a request or a bad response head", async () => {
    const pipe = relayPipe();
    const client = relayClient(pipe.app);
    const heads: Uint8Array[] = [];
    pipe.host.attach({ receive: (data) => heads.push(data), closed: () => undefined });
    const pending = client.fetch("/x");
    await vi.waitFor(() => expect(heads).toHaveLength(1));
    pipe.host.send(encodeRelayFrame(RelayFrameType.response, 1, text('{"status":99}')));
    await expect(pending).rejects.toThrow("bad response head");
    const badHeader = client.fetch("/z");
    const head = { status: 200, statusText: "", headers: [["bad name", "x"]] };
    pipe.host.send(encodeRelayFrame(RelayFrameType.response, 2, text(JSON.stringify(head))));
    await expect(badHeader).rejects.toThrow("bad response head");
    const headless = client.fetch("/w");
    pipe.host.send(encodeRelayFrame(RelayFrameType.end, 3));
    await expect(headless).rejects.toThrow("ended before a response");
    const second = client.fetch("/y");
    pipe.host.send(encodeRelayFrame(RelayFrameType.request, 9, text("{}")));
    await expect(second).rejects.toThrow("unexpected request frame");
  });

  it("drops a response that arrives after the caller left", async () => {
    const answer = deferred<Response>();
    const events = controlledBody();
    const { client } = setup(() => answer.promise);
    const abort = new AbortController();
    const pending = client.fetch("/late", { signal: abort.signal });
    await flush();
    abort.abort();
    await expect(pending).rejects.toThrow();
    answer.resolve(new Response(events.body));
    await expect(events.cancelled.promise).resolves.toBeUndefined();
  });

  it("runs over the sealed channel to a loopback server, and the relay sees no plaintext", async () => {
    const http = createServer((request, response) => {
      if (request.url === "/api/live") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: hello\n\n");
        request.on("close", () => response.end());
        return;
      }
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
      });
      request.on("end", () =>
        response.end(JSON.stringify({ path: request.url, size, secret: "placeholder-reply" })),
      );
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    cleanups.push(() => {
      http.closeAllConnections();
      http.close();
    });
    const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

    const crypto = webRelayCrypto();
    const secret = crypto.randomBytes(32);
    const { psk } = await relayPairingSecrets(crypto, secret);
    const hostKey = await crypto.generateKeyPair();
    const appKey = await crypto.generateKeyPair();
    const pipe = relayPipe();
    const channel = encodeRelayBytes(crypto.randomBytes(16));
    const [host, app] = await Promise.all([
      acceptHostChannel({ crypto, transport: pipe.host, channel, psk, hostKey, appKey: null }),
      openAppChannel({
        crypto,
        transport: pipe.app,
        channel,
        psk,
        appKey,
        hostKey: hostKey.publicKey,
      }),
    ]);
    serveRelay(host, { origin, forward: (request) => fetch(request) });
    const client = relayClient(app);
    cleanups.push(() => client.close());

    const response = await client.fetch("/api/upload", {
      method: "POST",
      headers: { authorization: "Bearer placeholder-session" },
      body: "placeholder-body",
    });
    expect(await response.json()).toEqual({
      path: "/api/upload",
      size: 16,
      secret: "placeholder-reply",
    });

    const live = await client.fetch("/api/live");
    const reader = live.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: hello\n\n");
    await reader?.cancel();

    for (const { data } of pipe.log) {
      for (const plain of [
        "placeholder-session",
        "placeholder-body",
        "placeholder-reply",
        "/api/upload",
        "data: hello",
      ]) {
        expect(containsBytes(data, text(plain))).toBe(false);
      }
    }
    // Overhead: a frame alone in a record costs its header plus the record's, 32 bytes.
    const sent = pipe.log.length;
    host.send(encodeRelayFrame(RelayFrameType.window, 99, new Uint8Array(4)));
    const fromHost = () => pipe.log.slice(sent).filter((entry) => entry.from === "host");
    await vi.waitFor(() => expect(fromHost()).toHaveLength(1));
    expect(fromHost()[0]?.data.length).toBe(RELAY_RECORD_OVERHEAD + RELAY_FRAME_HEADER_BYTES + 4);
  });
});
