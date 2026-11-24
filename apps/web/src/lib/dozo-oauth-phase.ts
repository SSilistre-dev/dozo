import { useState } from "react";

/** How often to check a pasted code's exchange: the server finishes it within a second or two. */
export const CODE_EXCHANGE_POLL_MS = 1000;

type OAuthPhase = "idle" | "waiting" | "connecting";

/**
 * The sign-in attempt's one phase: nothing running, waiting for a code or a login, or exchanging
 * a code that was just submitted. The setters keep the pending and submitting names of the hook
 * that uses it; ending a submit without ending the attempt goes back to waiting.
 */
export function useOAuthPhase() {
  const [phase, setPhase] = useState<OAuthPhase>("idle");
  return {
    oauthPending: phase !== "idle",
    oauthSubmitting: phase === "connecting",
    setOauthPending: (pending: boolean) => setPhase(pending ? "waiting" : "idle"),
    setOauthSubmitting: (submitting: boolean) =>
      setPhase((current) =>
        submitting ? "connecting" : current === "connecting" ? "waiting" : current,
      ),
  };
}
