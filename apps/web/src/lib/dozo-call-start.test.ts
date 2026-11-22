import type { DozoCallCheck } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The macro compiles away in the app build; tests run the source, so tag the template as-is.
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
}));

const mocks = vi.hoisted(() => ({
  startCall: vi.fn(),
  check: vi.fn(),
  toastError: vi.fn(),
  report: vi.fn(),
}));

vi.mock("./dozo-error-text", () => ({ toastError: mocks.toastError }));

import {
  CALL_CHECK_WAIT_MS,
  dozoCallRefusal,
  dozoCheckCall,
  dozoStartCall,
} from "./dozo-call-start";

const call = { botId: "bot-1", botName: "Ada", transcribe: true };
const answer = (patch: Partial<DozoCallCheck>): DozoCallCheck => ({
  checked: true,
  refusal: null,
  serverDictation: false,
  ...patch,
});

function offline(value: boolean) {
  vi.stubGlobal("navigator", { onLine: !value });
}

beforeEach(() => {
  vi.stubGlobal("window", { rakazoDesktop: undefined });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const mock of [mocks.startCall, mocks.check, mocks.toastError, mocks.report, end]) {
    mock.mockReset();
  }
});

const end = vi.fn();
const calls = () => ({
  start: mocks.startCall,
  end,
  check: mocks.check,
  report: mocks.report,
});

/** Node's own timeout signal ignores the fake clock: tie it to it. */
function fakeDeadlines() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
    return controller.signal;
  });
}

describe("starting a call", () => {
  it("starts it ringing at once, and tells it what the check finds", async () => {
    const pending = deferred<DozoCallCheck>();
    mocks.check.mockReturnValue(pending.promise);
    const starting = dozoStartCall(call, calls());
    // Ringing has begun before the check is back.
    expect(mocks.startCall).toHaveBeenCalledOnce();
    const started = mocks.startCall.mock.calls[0]?.[0];
    expect(started).toMatchObject({ botId: "bot-1", transcribe: true });
    pending.resolve(answer({ serverDictation: true }));
    await starting;
    expect(await started.check).toEqual({ serverDictation: true });
    expect(mocks.check).toHaveBeenCalledWith("bot-1", expect.any(AbortSignal));
    expect(end).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it.each([
    ["speech", "Can't call: the speech server isn't answering."],
    ["model", "Can't call: the model isn't answering."],
  ] as const)(
    "drops the ringing call when the %s does not answer, and says why",
    async (refusal, copy) => {
      mocks.check.mockResolvedValue(answer({ refusal }));
      await dozoStartCall(call, calls());
      expect(end).toHaveBeenCalledOnce();
      expect(mocks.toastError).toHaveBeenCalledWith(copy);
    },
  );

  it("leaves the call as it always was where nothing was checked", async () => {
    mocks.check.mockResolvedValue(answer({ checked: false, refusal: "model" }));
    offline(true);
    await dozoStartCall(call, calls());
    expect(mocks.startCall).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("leaves the call alone when the check fails, and reports that", async () => {
    mocks.check.mockRejectedValue(new Error("boom"));
    await dozoStartCall(call, calls());
    const started = mocks.startCall.mock.calls[0]?.[0];
    expect(await started.check).toEqual({ serverDictation: undefined });
    expect(end).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledWith(expect.any(Error));
  });

  it("ignores a second tap while the first is being checked", async () => {
    const pending = deferred<DozoCallCheck>();
    mocks.check.mockReturnValue(pending.promise);
    const first = dozoStartCall(call, calls());
    await dozoStartCall(call, calls());
    expect(mocks.check).toHaveBeenCalledTimes(1);
    pending.resolve(answer({}));
    await first;
    mocks.check.mockResolvedValue(answer({}));
    await dozoStartCall(call, calls());
    expect(mocks.startCall).toHaveBeenCalledTimes(2);
  });

  it("does not wait for a check that never comes back, and takes the next tap after it", async () => {
    fakeDeadlines();
    // The request never settles and ignores its signal.
    mocks.check.mockReturnValue(deferred<DozoCallCheck>().promise);
    const starting = dozoStartCall(call, calls());
    await vi.advanceTimersByTimeAsync(CALL_CHECK_WAIT_MS - 1);
    let settled = false;
    void starting.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await starting;
    const started = mocks.startCall.mock.calls[0]?.[0];
    expect(await started.check).toEqual({ serverDictation: undefined });
    expect(end).not.toHaveBeenCalled();
    expect(CALL_CHECK_WAIT_MS).toBe(4_000);
    // The tap after it is not shut out by the one that hung.
    mocks.check.mockResolvedValue(answer({}));
    await dozoStartCall(call, calls());
    expect(mocks.startCall).toHaveBeenCalledTimes(2);
  });
});

describe("why a call cannot start", () => {
  it("is the offline sentence when the device is offline and nothing can hear the caller", () => {
    offline(true);
    expect(dozoCallRefusal(answer({}))).toBe(
      "Can't call: no internet and no speech recognition on this device.",
    );
  });

  it("is nothing when the device is online", () => {
    offline(false);
    expect(dozoCallRefusal(answer({}))).toBeNull();
  });

  it("is nothing offline when the speech server hears the caller", () => {
    offline(true);
    expect(dozoCallRefusal(answer({ serverDictation: true }))).toBeNull();
  });

  it("is nothing offline when the desktop app has its own recognizer", () => {
    offline(true);
    vi.stubGlobal("window", { rakazoDesktop: { speech: {} } });
    expect(dozoCallRefusal(answer({}))).toBeNull();
  });

  it("is nothing without a check", () => {
    offline(true);
    expect(dozoCallRefusal(null)).toBeNull();
  });
});

describe("checking a call before answering it", () => {
  it("gives the refusal and says whether the speech server hears the caller", async () => {
    mocks.check.mockResolvedValue(answer({ refusal: "model", serverDictation: true }));
    expect(await dozoCheckCall("bot-1", calls())).toEqual({
      refusal: "Can't call: the model isn't answering.",
      serverDictation: true,
    });
    expect(mocks.startCall).not.toHaveBeenCalled();
  });

  it("refuses nothing when the check cannot be made", async () => {
    mocks.check.mockRejectedValue(new Error("boom"));
    expect(await dozoCheckCall("bot-1", calls())).toEqual({
      refusal: null,
      serverDictation: undefined,
    });
  });
});
