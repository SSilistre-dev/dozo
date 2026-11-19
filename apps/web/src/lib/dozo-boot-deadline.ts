import { deadlineSignal, withAbort } from "@rakazo/core";

/**
 * How long a read the first screen waits for may stay unanswered. Then it fails, and the screen's
 * own failure path takes over (the reconnect screen, a retry, English, or opening without it), so
 * one stalled request never leaves the app on an empty or spinning screen.
 */
export const BOOT_READ_MS = 10_000;

/** The requests the first screen cannot draw without; every other request keeps its own pace. */
const BOOT_READS = new Set([
  "/api/auth/get-session",
  "/rpc/bootstrap",
  "/rpc/me",
  "/rpc/billing/status",
]);

/** `signal`, bounded by `BOOT_READ_MS` when `url` is one of the first screen's reads. */
export function bootReadSignal(url: string, signal?: AbortSignal): AbortSignal | undefined {
  const { pathname } = new URL(url, "http://local");
  return BOOT_READS.has(pathname) ? deadlineSignal(BOOT_READ_MS, signal ?? undefined) : signal;
}

/** `fetch` with the first screen's reads bounded, for the auth client. */
export function bootReadFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return fetch(input, { ...init, signal: bootReadSignal(url, signal ?? undefined) });
}

/** A lazy chunk the first screen waits for (the language catalog), failing after `BOOT_READ_MS`. */
export function bootChunk<T>(load: Promise<T>): Promise<T> {
  return withAbort(load, deadlineSignal(BOOT_READ_MS));
}
