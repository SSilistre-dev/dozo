/** Appended to a one-time wait's run when the watched thing changed, after the change note. */
export const DOZO_WAIT_CHANGED_NOTE = "\n\nThis was a one-time wait; it has ended.";

/** A one-time wait's run when nothing changed in time. */
export function dozoWaitTimedOutNote(watched: string, minutes: number): string {
  return `\n\nThis run was started because a one-time wait on ${watched} ended after ${minutes} minutes without a change. The wait has ended; follow the instructions above for that case.`;
}
