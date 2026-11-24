import { useTimeout } from "@rakazo/chat-ui/hooks";
import { useState } from "react";

/** How long an open, running computer may be without its screen before its window says so. */
export const SCREEN_WAIT_MS = 30_000;
/**
 * How long a boot may show progress before it counts as failed. A wake takes about 30 to 40
 * seconds; this is the two minutes the mobile app already gives a start before it stops waiting.
 */
export const BOOT_WAIT_MS = 120_000;

export type ComputerWait = "boot" | "screen" | null;

/**
 * What a computer is waiting for, if anything: its boot, or (in its open window, once running)
 * its screen. Nothing once something has failed; the failure shows instead.
 */
export function computerWait(options: {
  computerOpen: boolean;
  state: string | undefined;
  runsOnUserMachine: boolean;
  bootShown: boolean;
  embeddedUrl: string | null;
  screenUrlLoaded: boolean;
  failed: boolean;
}): ComputerWait {
  if (options.failed) return null;
  if (options.bootShown) return "boot";
  return options.computerOpen &&
    options.state === "running" &&
    !options.runsOnUserMachine &&
    !options.embeddedUrl &&
    !options.screenUrlLoaded
    ? "screen"
    : null;
}

/**
 * Whether a boot shows progress: this tab's own boot of the computer's bot (also before its
 * status is known), or a computer the server says is booting.
 */
export function bootShown(
  bootingBotId: string | null,
  botId: string | undefined,
  state: string | undefined,
): boolean {
  return (bootingBotId !== null && bootingBotId === botId) || state === "booting";
}

/**
 * A wait that ends: progress while it lasts, then `bootTimedOut` or `screenTimedOut`, which the
 * window shows as the matching error with Retry. A wait that ends by itself (a late answer) clears
 * it; so does another bot's computer, which never inherits a spent wait. `restart` is for Retry.
 */
export function useComputerWait(wait: ComputerWait, botId: string | undefined) {
  const [attempt, setAttempt] = useState(0);
  const [spent, setSpent] = useState<string | null>(null);
  const id = wait ? `${botId ?? ""}:${wait}:${attempt}` : null;
  // Only the wait it belongs to stays spent: a late answer, another bot or Retry starts over.
  if (spent && spent !== id) setSpent(null);
  const timedOut = id !== null && spent === id;
  useTimeout(
    () => setSpent(id),
    wait && !timedOut ? (wait === "boot" ? BOOT_WAIT_MS : SCREEN_WAIT_MS) : null,
    id,
  );
  return {
    waiting: wait === "screen" && !timedOut,
    bootTimedOut: wait === "boot" && timedOut,
    screenTimedOut: wait === "screen" && timedOut,
    restart: () => setAttempt((current) => current + 1),
  };
}
