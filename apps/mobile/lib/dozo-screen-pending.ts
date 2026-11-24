/**
 * A running computer whose screen link has not come yet, with nothing failed: its preview shows the
 * boot progress until the link arrives (the status poll reads it), never the computer's bare name.
 */
export function screenPending(
  state: string | undefined,
  screenUrl: string | null,
  error: string | null,
): boolean {
  return state === "running" && !screenUrl && !error;
}
