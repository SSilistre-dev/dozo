import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./async.test-support.js";
import { isRequestUnreached, retryWhenUnreached } from "./dozo-unreached-retry.js";

/** What oRPC's web client throws for an answer that is not one of the API's errors. */
const proxyBody = (status: number, code: string) =>
  Object.assign(new Error(code), {
    code,
    status,
    data: { status, headers: {}, body: "no service" },
  });
/** An error the API sent: the client rebuilds it from its own JSON. */
const apiError = (status: number, code: string) => Object.assign(new Error(code), { code, status });
/** What mobile throws: an error with a status and the API's code, if the body had one. */
const mobileError = (status: number, code?: string) =>
  Object.assign(new Error("failed"), { status, code });

describe("isRequestUnreached", () => {
  it.each([
    ["a web proxy 502", proxyBody(502, "BAD_GATEWAY")],
    ["a web proxy 503", proxyBody(503, "SERVICE_UNAVAILABLE")],
    ["a web proxy 504", proxyBody(504, "GATEWAY_TIMEOUT")],
    ["a web proxy 404", proxyBody(404, "NOT_FOUND")],
    ["a mobile gateway answer with no API code", mobileError(502)],
    ["a mobile 404 with no API code", mobileError(404)],
    ["a refused connection", new TypeError("Failed to fetch")],
    ["a native network failure", new Error("Network request failed")],
  ])("is true for %s", (_, error) => {
    expect(isRequestUnreached(error)).toBe(true);
  });

  it.each([
    ["the API's own 404", apiError(404, "NOT_FOUND")],
    ["the API's own 503", apiError(503, "SERVICE_UNAVAILABLE")],
    ["the API's conflict", apiError(409, "CONFLICT")],
    ["the API's server error", apiError(500, "INTERNAL_SERVER_ERROR")],
    ["a mobile API 404", mobileError(404, "NOT_FOUND")],
    ["a mobile API conflict", mobileError(409, "CONFLICT")],
    ["a proxy 500", proxyBody(500, "INTERNAL_SERVER_ERROR")],
    ["a timeout", Object.assign(new Error("Request timed out"), { name: "TimeoutError" })],
    ["a cancellation", Object.assign(new Error("Failed to fetch"), { name: "AbortError" })],
    ["an unrelated error", new Error("boom")],
    ["a value that is not an error", "nope"],
  ])("is false for %s", (_, error) => {
    expect(isRequestUnreached(error)).toBe(false);
  });
});

describe("retryWhenUnreached", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the same arguments again until the API answers, staying pending meanwhile", async () => {
    const call = vi
      .fn<(input: { id: string }) => Promise<string>>()
      .mockRejectedValueOnce(proxyBody(502, "BAD_GATEWAY"))
      .mockRejectedValueOnce(proxyBody(404, "NOT_FOUND"))
      .mockResolvedValue("ok");
    const settled = vi.fn();
    const result = retryWhenUnreached(call)({ id: "a" }).then(settled);

    await vi.advanceTimersByTimeAsync(0);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(call).toHaveBeenCalledTimes(2);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await result;
    expect(call.mock.calls).toEqual([[{ id: "a" }], [{ id: "a" }], [{ id: "a" }]]);
    expect(settled).toHaveBeenCalledWith("ok");
  });

  it("holds a call that is still in flight instead of sending a second", async () => {
    const open = deferred<string>();
    const call = vi.fn(() => open.promise);
    const result = retryWhenUnreached(call)();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(call).toHaveBeenCalledTimes(1);
    open.resolve("late");
    await expect(result).resolves.toBe("late");
  });

  it("gives up after just over a minute with the last failure", async () => {
    const call = vi.fn(async () => {
      throw proxyBody(502, "BAD_GATEWAY");
    });
    const result = retryWhenUnreached(call)();
    const failure = expect(result).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(62_000);
    expect(call).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(1_000);
    await failure;
    expect(call).toHaveBeenCalledTimes(11);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["the API's conflict", apiError(409, "CONFLICT")],
    ["the API's own 503", apiError(503, "SERVICE_UNAVAILABLE")],
    ["a timeout", Object.assign(new Error("Request timed out"), { name: "TimeoutError" })],
  ])("never sends again after %s", async (_, error) => {
    const call = vi.fn(async () => {
      throw error;
    });
    await expect(retryWhenUnreached(call)()).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
