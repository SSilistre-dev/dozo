import type { ProductEvent } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { dozoRunStream, dozoStreamFrame, SSE_KEEPALIVE, sseFrame } from "./dozo-bot-api-stream.js";

let seq = 0;
function event(
  type: ProductEvent["type"],
  payload: Record<string, unknown> = {},
  runId: string | null = "run-1",
): ProductEvent {
  seq += 1;
  return {
    id: `e-${seq}`,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type,
    ...(runId === null ? {} : { runId }),
    createdAt: "2026-11-21T10:00:00.000Z",
    payload,
  };
}

describe("dozoStreamFrame", () => {
  it("streams the run's text and its working notes", () => {
    const delta = event("thread.progress", { delta: "lo", streaming: true });
    expect(dozoStreamFrame(delta, "run-1")).toEqual({
      id: delta.seq,
      event: "delta",
      data: { text: "lo" },
    });
    expect(
      dozoStreamFrame(event("thread.progress", { text: "Hel", streaming: true }), "run-1"),
    ).toMatchObject({ event: "delta", data: { text: "Hel" } });
    expect(
      dozoStreamFrame(event("thread.progress", { text: "Reading files", activity: true }), "run-1"),
    ).toMatchObject({ event: "activity", data: { text: "Reading files" } });
    expect(dozoStreamFrame(event("thread.progress", { text: "A note" }), "run-1")).toMatchObject({
      event: "activity",
      data: { text: "A note" },
    });
    expect(dozoStreamFrame(event("thread.progress", { other: 1 }), "run-1")).toBeNull();
  });

  it("gives a finished bot message whole, without the cards a run shows", () => {
    const message = event("thread.message.created", {
      messageId: "m-1",
      role: "bot",
      blocks: [{ kind: "text", text: "Done." }, { kind: "not-a-block" }],
    });
    expect(dozoStreamFrame(message, "run-1")).toEqual({
      id: message.seq,
      event: "message",
      data: { id: "m-1", text: "Done." },
    });
    expect(
      dozoStreamFrame(
        event("thread.message.created", { messageId: "m-2", role: "user", blocks: [] }),
        "run-1",
      ),
    ).toBeNull();
    expect(
      dozoStreamFrame(
        event("thread.message.created", { messageId: "m-3", role: "bot", blocks: [] }),
        "run-1",
      ),
    ).toBeNull();
  });

  it("ends on the run's end or a stop for the person", () => {
    for (const [type, status] of [
      ["run.completed", "completed"],
      ["run.failed", "failed"],
      ["run.cancelled", "cancelled"],
      ["run.waiting_input", "waiting_input"],
      ["computer.takeover.requested", "waiting_takeover"],
    ] as const)
      expect(dozoStreamFrame(event(type), "run-1")).toMatchObject({
        event: "status",
        data: { status },
      });
  });

  it("ignores other runs and events a client does not show", () => {
    expect(dozoStreamFrame(event("run.completed", {}, "run-2"), "run-1")).toBeNull();
    expect(dozoStreamFrame(event("run.completed", {}, null), "run-1")).toBeNull();
    expect(dozoStreamFrame(event("run.started"), "run-1")).toBeNull();
  });

  it("writes one frame per event with its id for resuming", () => {
    expect(sseFrame({ id: 7, event: "delta", data: { text: "a\nb" } })).toBe(
      'id: 7\nevent: delta\ndata: {"text":"a\\nb"}\n\n',
    );
    expect(sseFrame({ event: "status", data: { status: "running" } })).toBe(
      'event: status\ndata: {"status":"running"}\n\n',
    );
  });
});

async function read(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}

async function* events(list: ProductEvent[], signal?: AbortSignal) {
  for (const item of list) {
    if (signal?.aborted) return;
    yield item;
  }
}

describe("dozoRunStream", () => {
  it("sends the first frames, the run's frames and keepalives, and ends at the status", async () => {
    const onClose = vi.fn();
    const heartbeat = event("heartbeat", {}, null);
    const delta = event("thread.progress", { delta: "Hi" });
    const started = event("run.started");
    const done = event("run.completed");
    const after = event("thread.progress", { delta: "never" });
    const stream = dozoRunStream({
      runId: "run-1",
      first: [{ id: 1, event: "run", data: { runId: "run-1" } }],
      events: (signal) => events([heartbeat, delta, started, done, after], signal),
      signal: new AbortController().signal,
      maxMs: 60_000,
      onClose,
    });
    const text = await read(stream);
    expect(text).toBe(
      [
        'id: 1\nevent: run\ndata: {"runId":"run-1"}\n\n',
        SSE_KEEPALIVE,
        `id: ${delta.seq}\nevent: delta\ndata: {"text":"Hi"}\n\n`,
        `id: ${done.seq}\nevent: status\ndata: {"status":"completed"}\n\n`,
      ].join(""),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("replays a settled run up to where its thread stood, then ends with its status", async () => {
    const delta = event("thread.progress", { delta: "rest" });
    const head = event("thread.message.created", { messageId: "m-9", role: "user", blocks: [] });
    const later = event("thread.progress", { delta: "never" });
    const replayed = await read(
      dozoRunStream({
        runId: "run-1",
        settled: { status: "completed", headSeq: head.seq },
        events: (signal) => events([delta, head, later], signal),
        signal: new AbortController().signal,
        maxMs: 60_000,
      }),
    );
    expect(replayed).toBe(
      `id: ${delta.seq}\nevent: delta\ndata: {"text":"rest"}\n\nevent: status\ndata: {"status":"completed"}\n\n`,
    );
    // The head event never arrives (another run's, filtered out): the first quiet moment ends it.
    const quiet = await read(
      dozoRunStream({
        runId: "run-1",
        settled: { status: "failed", headSeq: 10_000 },
        events: (signal) => events([event("heartbeat", {}, null)], signal),
        signal: new AbortController().signal,
        maxMs: 60_000,
      }),
    );
    expect(quiet).toBe('event: status\ndata: {"status":"failed"}\n\n');
  });

  it("says the run is still going when the events end or the time is up", async () => {
    const ended = await read(
      dozoRunStream({
        runId: "run-1",
        events: () => events([]),
        signal: new AbortController().signal,
        maxMs: 60_000,
      }),
    );
    expect(ended).toBe('event: status\ndata: {"status":"running"}\n\n');

    const slow = await read(
      dozoRunStream({
        runId: "run-1",
        events: async function* (signal) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve));
          yield event("thread.progress", { delta: "late" });
        },
        signal: new AbortController().signal,
        maxMs: 5,
      }),
    );
    expect(slow).toBe('event: status\ndata: {"status":"running"}\n\n');
  });

  it("stops quietly when the client leaves", async () => {
    const client = new AbortController();
    const onClose = vi.fn();
    const stream = dozoRunStream({
      runId: "run-1",
      events: async function* (signal) {
        yield event("thread.progress", { delta: "a" });
        client.abort();
        if (signal.aborted) throw new Error("aborted");
      },
      signal: client.signal,
      maxMs: 60_000,
      onClose,
    });
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"a"');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await reader.cancel();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the reader cancels", async () => {
    const onClose = vi.fn();
    const stream = dozoRunStream({
      runId: "run-1",
      events: async function* (signal) {
        yield event("thread.progress", { delta: "a" });
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
      },
      signal: new AbortController().signal,
      maxMs: 60_000,
      onClose,
    });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fails the stream when following the run fails", async () => {
    const onClose = vi.fn();
    const stream = dozoRunStream({
      runId: "run-1",
      events: async function* () {
        yield* [];
        throw new Error("database down");
      },
      signal: new AbortController().signal,
      maxMs: 60_000,
      onClose,
    });
    await expect(read(stream)).rejects.toThrow("database down");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
