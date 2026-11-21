/**
 * A value this browser keeps for an hour, across its tabs: the confirmation mail's link often opens
 * in a new tab, where what sign-up kept for its own tab would be gone. Each value is stored with
 * when it expires; an expired or unreadable one counts as none and is removed when read. Storage
 * can be switched off, or refuse access, in a private window; then nothing is kept and nothing
 * fails.
 */
export const KEPT_FOR_MS = 60 * 60 * 1000;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Keeps `value` until `expiresAt` (an hour from now unless given). */
export function keepForAnHour(key: string, value: unknown, expiresAt = Date.now() + KEPT_FOR_MS) {
  try {
    storage()?.setItem(key, JSON.stringify({ value, expiresAt }));
  } catch {
    // A full or refused store keeps nothing.
  }
}

/** The value kept under `key` and when it expires; null, and removed, once expired or unreadable. */
export function readKept(key: string): { value: unknown; expiresAt: number } | null {
  let raw: string | null;
  try {
    raw = storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  const kept = parse(raw);
  if (!kept) forgetKept(key);
  return kept;
}

function parse(raw: string): { value: unknown; expiresAt: number } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { value, expiresAt } = parsed as Record<string, unknown>;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
    const left = expiresAt - Date.now();
    // Further off than an hour is not a value this file wrote.
    if (left < 0 || left > KEPT_FOR_MS) return null;
    return { value, expiresAt };
  } catch {
    return null;
  }
}

export function forgetKept(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing kept that can be removed.
  }
}
