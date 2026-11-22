import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ report: vi.fn(), check: vi.fn() }));
vi.mock("./monitoring", () => ({ reportClientError: mocks.report }));
vi.mock("./rpc", () => ({ rpc: { dozoCallPreflight: { check: mocks.check } } }));

import { checkBeforeAnswer, placeCall } from "./dozo-call-gate";

afterEach(() => vi.clearAllMocks());

const call = { botId: "bot-1", botName: "Ada" };
const chunkGone = () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module"));

describe("placing a call", () => {
  it("goes through the check when it loads", async () => {
    const dozoStartCall = vi.fn(async () => undefined);
    const calls = { start: vi.fn(), end: vi.fn() };
    await placeCall(call, calls, (async () => ({ dozoStartCall })) as never);
    expect(dozoStartCall).toHaveBeenCalledWith(call, expect.objectContaining(calls));
    expect(calls.start).not.toHaveBeenCalled();
  });

  it("starts the call as it did before the check when the check cannot be loaded, and reports it", async () => {
    const calls = { start: vi.fn(), end: vi.fn() };
    await placeCall(call, calls, chunkGone as never);
    expect(calls.start).toHaveBeenCalledOnce();
    expect(calls.start).toHaveBeenCalledWith(call);
    expect(mocks.report).toHaveBeenCalledWith(expect.any(TypeError), "voice.turn");
  });
});

describe("checking before an incoming call is answered", () => {
  it("gives what the check says", async () => {
    const dozoCheckCall = vi.fn(async () => ({ refusal: "no", serverDictation: true }));
    expect(await checkBeforeAnswer("bot-1", (async () => ({ dozoCheckCall })) as never)).toEqual({
      refusal: "no",
      serverDictation: true,
    });
    expect(dozoCheckCall).toHaveBeenCalledWith("bot-1", expect.anything());
  });

  it("refuses nothing when the check cannot be loaded, and reports it", async () => {
    expect(await checkBeforeAnswer("bot-1", chunkGone as never)).toEqual({
      refusal: null,
      serverDictation: undefined,
    });
    expect(mocks.report).toHaveBeenCalledWith(expect.any(TypeError), "voice.turn");
  });
});

describe("what the gate hands the check", () => {
  it("is the page's own request, bounded by the signal, and its error report", async () => {
    mocks.check.mockResolvedValue({ checked: true, refusal: null, serverDictation: false });
    let wiring: Parameters<typeof import("./dozo-call-start").dozoCheckCall>[1] | undefined;
    const dozoCheckCall = vi.fn(async (_botId: string, handed: typeof wiring) => {
      wiring = handed;
      return { refusal: null, serverDictation: undefined };
    });
    await checkBeforeAnswer("bot-1", (async () => ({ dozoCheckCall })) as never);
    const signal = new AbortController().signal;
    await wiring?.check("bot-1", signal);
    expect(mocks.check).toHaveBeenCalledWith({ botId: "bot-1" }, { signal });
    const error = new Error("x");
    wiring?.report(error);
    expect(mocks.report).toHaveBeenCalledWith(error, "voice.turn");
  });
});
