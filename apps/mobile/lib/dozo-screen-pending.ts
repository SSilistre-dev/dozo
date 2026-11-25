import { useTimeout } from "@rakazo/chat-ui/hooks";
import { useState } from "react";
import type { ComputerStatus } from "./computers/computer";

/** How long a running computer may go without its screen link before its preview says so. */
export const SCREEN_PENDING_MS = 30_000;

type Computer = Pick<ComputerStatus, "state" | "kind" | "screenAvailable" | "runsOnUserMachine">;

/**
 * A running computer that has a screen to show, whose screen link has not come yet, with nothing
 * failed. The user's own machine and a computer the server says has no screen never wait.
 */
export function screenPending(
  computer: Computer | null | undefined,
  screenUrl: string | null,
  error: string | null,
): boolean {
  if (computer?.state !== "running" || screenUrl || error) return false;
  const ownMachine = computer.runsOnUserMachine ?? computer.kind === "desktop";
  return !ownMachine && computer.screenAvailable !== false;
}

/**
 * The preview's wait for the screen link: progress while it lasts, then `timedOut`, which the
 * preview shows as the screen's error while the status poll keeps reading. A link that arrives
 * late still shows, and a new wait starts from the beginning.
 */
export function useScreenPending(
  computer: Computer | null | undefined,
  screenUrl: string | null,
  error: string | null,
) {
  const pending = screenPending(computer, screenUrl, error);
  const [timedOut, setTimedOut] = useState(false);
  if (!pending && timedOut) setTimedOut(false);
  useTimeout(() => setTimedOut(true), pending && !timedOut ? SCREEN_PENDING_MS : null);
  return { pending: pending && !timedOut, timedOut: pending && timedOut };
}
