import { t } from "@lingui/core/macro";
import type { ModelPreflightFailure } from "../lib/model-connection-preflight";

/**
 * A failed connection test's first line in the UI's language. The kinds read from the provider's
 * answer (a status, a timeout) say it in the app's own sentence, never the provider's or the
 * server's English; the kinds the app worded itself keep their line.
 */
export function preflightMessage(failure: ModelPreflightFailure): string {
  switch (failure.outcome) {
    case "timeout":
      return t`The connection timed out.`;
    case "rate_limit":
      return t`The provider is rate-limiting requests.`;
    case "unauthorized":
      return t`Authentication failed.`;
    case "unreachable":
      return t`Could not reach the model server.`;
    case "unknown":
      return t`Connection test failed.`;
    default:
      return failure.message;
  }
}
