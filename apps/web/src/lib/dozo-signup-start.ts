import { forgetKept, keepForAnHour, readKept } from "./dozo-kept-for-an-hour";

const KEY = "dozo:signup-started";

/**
 * The sign-up form is open: keeps when this browser first opened it, for an hour or until an
 * account takes it (`dozo-kept-for-an-hour`), so the tab the confirmation mail opens has it too.
 */
export function markSignupStarted(): void {
  if (!startIn(readKept(KEY)?.value)) keepForAnHour(KEY, new Date().toISOString());
}

/** When this browser opened the sign-up form, taken once; null without a valid one. */
export function takeSignupStarted(): string | null {
  const startedAt = startIn(readKept(KEY)?.value);
  forgetKept(KEY);
  return startedAt;
}

/** A start this file wrote: an exact ISO time, not after now. */
function startIn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  if (Number.isNaN(time) || time > Date.now()) return null;
  return new Date(time).toISOString() === value ? value : null;
}
