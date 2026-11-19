import { t } from "@lingui/core/macro";
import { toast } from "@rakazo/ui-web";
import { errorText as upstreamErrorText } from "./user-error";

/**
 * Upstream's `errorText` without the server's own words. A failure the server answered (it carries
 * an HTTP status) whose message would be shown as it is becomes the caller's copy; the message goes
 * to the console. Copy the client wrote and the codes upstream translates pass as before.
 */
export function errorText(error: unknown, fallback = t`Something went wrong. Try again.`): string {
  const text = upstreamErrorText(error, fallback);
  if (!answeredByServer(error) || text !== error.message.trim()) return text;
  console.warn("Server error shown as generic copy:", error.message);
  return fallback;
}

/**
 * The one way a failure becomes a toast: `copy` alone, or `error` through `errorText` with `copy`
 * as its fallback.
 */
export function toastError(
  copy: string,
  error?: unknown,
  options?: Parameters<typeof toast.error>[1],
): void {
  const text = error === undefined ? copy : errorText(error, copy);
  // Without options the call is upstream's own `toast.error(text)`.
  if (options) toast.error(text, options);
  else toast.error(text);
}

function answeredByServer(error: unknown): error is Error & { status: number } {
  return error instanceof Error && typeof (error as { status?: unknown }).status === "number";
}
