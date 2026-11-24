import { useTimeout } from "@rakazo/chat-ui/hooks";
import { useState } from "react";

/** How long an open, running computer may be without its screen before its window says so. */
export const SCREEN_WAIT_MS = 30_000;

/**
 * True while the open window of a running computer has no screen and nothing has failed: its
 * screen read is still out, or was never answered. The window shows that as progress, never as
 * the computer's bare name.
 */
export function screenAwaited(options: {
  computerOpen: boolean;
  state: string | undefined;
  runsOnUserMachine: boolean;
  booting: boolean;
  embeddedUrl: string | null;
  screenUrlLoaded: boolean;
  failed: boolean;
}): boolean {
  return (
    options.computerOpen &&
    options.state === "running" &&
    !options.runsOnUserMachine &&
    !options.booting &&
    !options.embeddedUrl &&
    !options.screenUrlLoaded &&
    !options.failed
  );
}

/**
 * A wait for the screen that ends: progress while it lasts, then `timedOut`, which the window
 * shows as the screen's error with Retry. A screen that arrives late still shows; `restart` is for
 * that Retry, which waits again from the start.
 */
export function useScreenWait(awaited: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  if (!awaited && timedOut) setTimedOut(false);
  useTimeout(() => setTimedOut(true), awaited && !timedOut ? SCREEN_WAIT_MS : null, attempt);
  return {
    waiting: awaited && !timedOut,
    timedOut: awaited && timedOut,
    restart: () => {
      setTimedOut(false);
      setAttempt((current) => current + 1);
    },
  };
}
