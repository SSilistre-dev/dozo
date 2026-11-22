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
vi.mock("./monitoring", () => ({ reportClientError: mocks.report }));
vi.mock("./rpc", () => ({ rpc: { dozoCallPreflight: { check: mocks.check } } }));

import { dozoCallRefusal, dozoCheckCall, dozoStartCall } from "./dozo-call-start";

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const mock of [mocks.startCall, mocks.check, mocks.toastError, mocks.report]) {
    mock.mockReset();
  }
});

describe("starting a call", () => {
  it("starts it, with whether the speech server hears the caller, once everything answers", async () => {
    mocks.check.mockResolvedValue(answer({ serverDictation: true }));
    await dozoStartCall(call, mocks.startCall);
    expect(mocks.check).toHaveBeenCalledWith({ botId: "bot-1" });
    expect(mocks.startCall).toHaveBeenCalledWith({ ...call, serverDictation: true });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it.each([
    ["speech", "Can't call: the speech server isn't answering."],
    ["model", "Can't call: the model isn't answering."],
  ] as const)(
    "does not start it when the %s does not answer, and says why",
    async (refusal, copy) => {
      mocks.check.mockResolvedValue(answer({ refusal }));
      await dozoStartCall(call, mocks.startCall);
      expect(mocks.startCall).not.toHaveBeenCalled();
      expect(mocks.toastError).toHaveBeenCalledWith(copy);
    },
  );

  it("starts it as it always did where nothing was checked", async () => {
    mocks.check.mockResolvedValue(
      answer({ checked: false, refusal: "model", serverDictation: false }),
    );
    offline(true);
    await dozoStartCall(call, mocks.startCall);
    expect(mocks.startCall).toHaveBeenCalledWith({ ...call, serverDictation: false });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("starts it as it always did when the check itself fails, and reports that", async () => {
    mocks.check.mockRejectedValue(new Error("boom"));
    await dozoStartCall(call, mocks.startCall);
    expect(mocks.startCall).toHaveBeenCalledWith({ ...call, serverDictation: undefined });
    expect(mocks.report).toHaveBeenCalledWith(expect.any(Error), "voice.turn");
  });

  it("ignores a second tap while the first is being checked", async () => {
    const pending = deferred<DozoCallCheck>();
    mocks.check.mockReturnValue(pending.promise);
    const first = dozoStartCall(call, mocks.startCall);
    await dozoStartCall(call, mocks.startCall);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    pending.resolve(answer({}));
    await first;
    expect(mocks.startCall).toHaveBeenCalledTimes(1);
    mocks.check.mockResolvedValue(answer({}));
    await dozoStartCall(call, mocks.startCall);
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
    expect(await dozoCheckCall("bot-1")).toEqual({
      refusal: "Can't call: the model isn't answering.",
      serverDictation: true,
    });
    expect(mocks.startCall).not.toHaveBeenCalled();
  });

  it("refuses nothing when the check cannot be made", async () => {
    mocks.check.mockRejectedValue(new Error("boom"));
    expect(await dozoCheckCall("bot-1")).toEqual({ refusal: null, serverDictation: undefined });
  });
});
