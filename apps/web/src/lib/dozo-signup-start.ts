const KEY = "dozo:signup-started";

function storage(): Storage | null {
  // Storage can be switched off, or refuse access, in a private window; then nothing is kept.
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The sign-up form is open: keeps when this tab first opened it, until an account takes it. */
export function markSignupStarted(): void {
  try {
    const store = storage();
    if (store && !store.getItem(KEY)) store.setItem(KEY, new Date().toISOString());
  } catch {
    // A full or refused store keeps nothing; the start goes unreported.
  }
}

/** When this tab opened the sign-up form, taken once; null without a valid one. */
export function takeSignupStarted(): string | null {
  try {
    const store = storage();
    const startedAt = store?.getItem(KEY) ?? null;
    store?.removeItem(KEY);
    return startedAt !== null && !Number.isNaN(Date.parse(startedAt)) ? startedAt : null;
  } catch {
    return null;
  }
}
