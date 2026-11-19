import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_READ_MS, bootChunk, bootReadFetch, bootReadSignal } from "./dozo-boot-deadline";

beforeEach(() => {
  vi.useFakeTimers();
  // The runtime's own timeout signal does not follow fake timers; this one does.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
    return controller.signal;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("bootReadSignal", () => {
  it("bounds the first screen's reads, wherever the app is served", async () => {
    for (const url of [
      "https://app.example.com/rpc/bootstrap",
      "https://app.example.com/rpc/me",
      "https://app.example.com/rpc/billing/status",
      "/api/auth/get-session",
    ]) {
      const signal = bootReadSignal(url);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(BOOT_READ_MS);
      expect(signal?.aborted, url).toBe(true);
    }
  });

  it("keeps the caller's own cancellation on a bounded read", () => {
    const caller = new AbortController();
    const signal = bootReadSignal("https://app.example.com/rpc/bootstrap", caller.signal);
    caller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("leaves every other request as it was: streams and slow actions keep their own pace", () => {
    const caller = new AbortController();
    expect(
      bootReadSignal("https://app.example.com/rpc/notifications/subscribe", caller.signal),
    ).toBe(caller.signal);
    expect(bootReadSignal("https://app.example.com/rpc/bots/create")).toBeUndefined();
    expect(bootReadSignal("/api/auth/sign-in/email")).toBeUndefined();
  });
});

describe("bootReadFetch", () => {
  it("fails a session read that never answers, and passes other requests through", async () => {
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const session = bootReadFetch("/api/auth/get-session", { method: "GET" });
    const outcome = session.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(BOOT_READ_MS);
    expect(await outcome).toBeInstanceOf(DOMException);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");

    const request = new Request("https://app.example.com/api/auth/sign-in/email");
    void bootReadFetch(request);
    expect(fetch.mock.calls[1]?.[1]?.signal).toBe(request.signal);
  });
});

describe("bootChunk", () => {
  it("fails a chunk that never arrives, and passes one that does", async () => {
    const hung = bootChunk(new Promise(() => {})).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(BOOT_READ_MS);
    expect(await hung).toBeInstanceOf(DOMException);
    await expect(bootChunk(Promise.resolve("catalog"))).resolves.toBe("catalog");
  });
});
