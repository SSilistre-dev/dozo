import type { DozoClientEvent } from "@rakazo/contracts";
import { readPlanIntent } from "./dozo-plan-intent";
import { takeSignupStarted } from "./dozo-signup-start";
import { rpc } from "./rpc";

/**
 * The fork's product events the web app reports (`DozoClientEventSchema`). The server sends them
 * on only when analytics is configured; a failed report is measurement lost, never an error shown.
 */
export function reportEvent(event: DozoClientEvent): void {
  void rpc.dozoEvents.track(event).catch(() => undefined);
}

/** The paid plans are on screen: required to go on, opened in the app, or for a landing pick. */
export function reportUpgradeViewed(dismissible: boolean): void {
  reportEvent({
    name: "upgrade_viewed",
    source: !dismissible ? "paywall" : readPlanIntent() ? "landing" : "app",
  });
}

/**
 * Reports when this tab opened the sign-up form, once, for the account now signed in. The server
 * drops it unless the account was made within the hour after.
 */
export function reportSignupStarted(): void {
  const startedAt = takeSignupStarted();
  if (startedAt) reportEvent({ name: "signup_started", startedAt });
}
