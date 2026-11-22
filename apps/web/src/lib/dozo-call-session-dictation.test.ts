import { deferred } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endCall, startCall } from "./call-session";
import { dictation } from "./dictation.js";
import { speaker } from "./tts.js";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
}));
vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/core")>()),
  runThreadSubscription: vi.fn(async () => undefined),
}));
vi.mock("./call-pickup.js", () => ({ pickUp: vi.fn(async () => undefined) }));
vi.mock("./dictation.js", () => ({
  usesServerDictation: vi.fn(() => false),
  dictation: {
    recording: false,
    listen: vi.fn(async () => undefined),
    stop: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  },
}));
vi.mock("./tts.js", () => ({
  speaker: {
    speak: vi.fn(async () => undefined),
    stop: vi.fn(),
    unlock: vi.fn(),
    isSpeaking: vi.fn(() => false),
    subscribe: vi.fn(() => () => undefined),
  },
}));
vi.mock("./rpc.js", () => ({
  recheckSessionOnUnauthorized: vi.fn(),
  rpc: {
    threads: {
      endCall: vi.fn(async () => ({ ok: true })),
      get: vi.fn(async () => ({ threadId: "t", cursor: 0, messages: [] })),
      head: vi.fn(),
      subscribe: vi.fn(),
    },
  },
}));

const listen = vi.mocked(dictation.listen);

async function call(serverDictation: boolean | undefined) {
  startCall({
    botId: "bot-1",
    botName: "Ada",
    transcribe: true,
    serverDictation,
    answered: { callId: "call-1", opening: "" },
  });
  await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
}

function speakingEvent() {
  // The recognizer is running when the reply starts, as it is during a call.
  (dictation as { recording: boolean }).recording = true;
  const watcher = vi.mocked(speaker.subscribe).mock.calls.at(-1)?.[0];
  watcher?.({ status: "speaking", caption: "Hello" });
}

describe("a call told the speech server hears the caller", () => {
  beforeEach(() => {
    endCall();
    vi.clearAllMocks();
    (dictation as { recording: boolean }).recording = false;
  });
  afterEach(() => endCall());

  it("tells dictation, which then skips Web Speech", async () => {
    await call(true);
    expect(listen).toHaveBeenCalledWith(
      expect.objectContaining({ transcribe: true, serverDictation: true }),
    );
  });

  it("keeps the microphone shut over a reply, as server dictation does", async () => {
    await call(true);
    speakingEvent();
    await Promise.resolve();
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("leaves a call that was not told as it was", async () => {
    await call(undefined);
    expect(listen).toHaveBeenCalledWith(expect.objectContaining({ serverDictation: undefined }));
    // The recognizer in the browser can listen over the reply, so the mic opens again.
    speakingEvent();
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(2));
  });
});

describe("a call that is still being checked", () => {
  beforeEach(() => {
    endCall();
    vi.clearAllMocks();
  });
  afterEach(() => endCall());

  it("rings until the check is back, then listens by what it found", async () => {
    const check = deferred<{ serverDictation?: boolean } | null>();
    startCall({
      botId: "bot-1",
      botName: "Ada",
      transcribe: true,
      check: check.promise,
    });
    // The ringing has finished, but the check has not: the microphone stays shut.
    await Promise.resolve();
    await Promise.resolve();
    expect(listen).not.toHaveBeenCalled();
    check.resolve({ serverDictation: true });
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    expect(listen).toHaveBeenCalledWith(expect.objectContaining({ serverDictation: true }));
  });

  it("listens as before when the check found nothing to say", async () => {
    startCall({ botId: "bot-1", botName: "Ada", transcribe: true, check: Promise.resolve(null) });
    await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    expect(listen).toHaveBeenCalledWith(expect.objectContaining({ serverDictation: undefined }));
  });
});
