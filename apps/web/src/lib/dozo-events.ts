import type { DozoClientEvent } from "@rakazo/contracts";
import { sendEvent } from "./dozo-event-sender";
import { takeSignupStarted } from "./dozo-signup-start";
import { rpc } from "./rpc";

/** The fork's product events the web app reports (`DozoClientEventSchema`), through `sendEvent`. */
export function reportEvent(event: DozoClientEvent): void {
  sendEvent(rpc, event);
}

/**
 * Reports when this browser opened the sign-up form (within the hour, in any tab), once, for the account now signed in. The server
 * drops it unless the account was made within the hour after.
 */
export function reportSignupStarted(): void {
  const startedAt = takeSignupStarted();
  if (startedAt) reportEvent({ name: "signup_started", startedAt });
}
