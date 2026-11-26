import { retry } from "./primitives/retry.js";
import { errorStatus } from "./primitives/retry-policy.js";
import { isAbandonedRequest, isNetworkFailure, isUnreachableStatus } from "./primitives/user-error.js";

/** Waits between tries: 1, 2, 4 s, then 8 s each, so a call keeps trying for just over a minute. */
const WAIT_MS = [1_000, 2_000, 4_000, 8_000];
const ATTEMPTS = 11;

/**
 * The client's own copy of the failed response, which oRPC attaches as `data` when the body was
 * not one of the API's errors (a proxy's page). An error the API sent carries its own data.
 */
function isForeignResponse(data: unknown): boolean {
  return typeof data === "object" && data !== null && "headers" in data && "status" in data;
}

/**
 * True when the request provably never reached the API: no response at all (the network refused
 * it), or a proxy's own 404/502/503/504 with no API error in it. A timeout is left out, since the
 * API may have been working on it; so is any answer the API itself produced, errors included.
 */
export function isRequestUnreached(error: unknown): boolean {
  if (isAbandonedRequest(error)) return false;
  if (isNetworkFailure(error)) return true;
  const status = errorStatus(error);
  if (status === undefined || !(status === 404 || isUnreachableStatus(status))) return false;
  const { code, data } = error as { code?: unknown; data?: unknown };
  // Mobile reads an API error's code from its body; web turns a foreign body into a coded error
  // whose data is the response.
  return typeof code !== "string" || isForeignResponse(data);
}

/**
 * Wraps a call so that, while the API cannot be reached (a deploy replacing it), the same call is
 * sent again for about a minute. The caller sees one pending call, then its result or the last
 * failure. Only for a call the server refuses to apply twice.
 */
export function retryWhenUnreached<A extends unknown[], R>(
  call: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args) =>
    retry(() => call(...args), {
      attempts: ATTEMPTS,
      retryable: isRequestUnreached,
      delayMs: WAIT_MS,
    });
}
