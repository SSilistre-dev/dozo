import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ report: vi.fn(), check: vi.fn(), toast: vi.fn() }));
vi.mock("./platform/monitoring", () => ({ reportClientError: mocks.report }));
vi.mock("./dozo-error-text", () => ({ toastError: mocks.toast }));
vi.mock("./query/rpc", () => ({ rpc: { dozoCallPreflight: { check: mocks.check } } }));

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
  async function handed() {
    let wiring: Parameters<typeof import("./dozo-call-start").dozoCheckCall>[1] | undefined;
    const dozoCheckCall = vi.fn(async (_botId: string, given: typeof wiring) => {
      wiring = given;
      return { refusal: null, serverDictation: undefined };
    });
    await checkBeforeAnswer("bot-1", (async () => ({ dozoCheckCall })) as never);
    return wiring!;
  }

  afterEach(() => vi.useRealTimers());

  it("is the page's own request, and its error report and refusal", async () => {
    const wiring = await handed();
    mocks.check.mockResolvedValue({ checked: true, refusal: null, serverDictation: false });
    await wiring.check("bot-1", 3_000);
    expect(mocks.check).toHaveBeenCalledWith(
      { botId: "bot-1" },
      { signal: expect.any(AbortSignal) },
    );
    const error = new Error("x");
    wiring.report(error);
    expect(mocks.report).toHaveBeenCalledWith(error, "voice.turn");
    wiring.refuse("Can't call");
    expect(mocks.toast).toHaveBeenCalledWith("Can't call");
  });

  it("gives up on a request that never comes back, though it ignores its signal", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const wiring = await handed();
    mocks.check.mockReturnValue(new Promise(() => undefined));
    const waiting = wiring.check("bot-1", 4_000);
    const outcome = waiting.then(
      () => "answered",
      (error: Error) => error.name,
    );
    await vi.advanceTimersByTimeAsync(3_999);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("TimeoutError");
  });
});
