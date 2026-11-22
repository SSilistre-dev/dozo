import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("./monitoring", () => ({ reportClientError: mocks.report }));

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
    expect(dozoStartCall).toHaveBeenCalledWith(call, calls);
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
    expect(dozoCheckCall).toHaveBeenCalledWith("bot-1");
  });

  it("refuses nothing when the check cannot be loaded, and reports it", async () => {
    expect(await checkBeforeAnswer("bot-1", chunkGone as never)).toEqual({
      refusal: null,
      serverDictation: undefined,
    });
    expect(mocks.report).toHaveBeenCalledWith(expect.any(TypeError), "voice.turn");
  });
});
