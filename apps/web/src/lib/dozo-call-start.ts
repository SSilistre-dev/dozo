import { t } from "@lingui/core/macro";
import type { DozoCallCheck } from "@rakazo/contracts";
import { deadlineSignal, withAbort } from "@rakazo/core";
import type { startCall } from "./call-session";
import { toastError } from "./dozo-error-text";
import { reportClientError } from "./monitoring";
import { rpc } from "./rpc";

type Call = Parameters<typeof startCall>[0];

/** A second tap while the first is being checked starts nothing more. */
let checking = false;

/**
 * Why the call cannot start, in the words the person sees, or null. Without a check (a hosted
 * deployment, or one that could not be asked) nothing is refused. With one, a device that is
 * offline and has no recognizer of its own cannot hear the caller.
 */
export function dozoCallRefusal(check: DozoCallCheck | null): string | null {
  if (!check?.checked) return null;
  if (check.refusal === "speech") return t`Can't call: the speech server isn't answering.`;
  if (check.refusal === "model") return t`Can't call: the model isn't answering.`;
  // Read off the window, not through `desktopBridge`: that file would leave the first page's chunk.
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (offline && !check.serverDictation && !window.rakazoDesktop?.speech) {
    return t`Can't call: no internet and no speech recognition on this device.`;
  }
  return null;
}

/**
 * Longest the page waits for the check, a little over the server's own limit
 * (`CALL_CHECK_TOTAL_MS`): a check that does not come back never holds a call.
 */
export const CALL_CHECK_WAIT_MS = 4_000;

/**
 * Asks whether a call to this bot can start: the reason it cannot, in the words the person sees,
 * and whether the speech server hears the caller. A check that cannot be made, or does not come
 * back in time, refuses nothing, so the call itself then reports what is wrong. Never rejects.
 */
export async function dozoCheckCall(
  botId: string,
): Promise<{ refusal: string | null; serverDictation: boolean | undefined }> {
  let check: DozoCallCheck | null = null;
  try {
    const until = deadlineSignal(CALL_CHECK_WAIT_MS);
    check = await withAbort(rpc.dozoCallPreflight.check({ botId }, { signal: until }), until);
  } catch (error) {
    reportClientError(error, "voice.turn");
  }
  return { refusal: dozoCallRefusal(check), serverDictation: check?.serverDictation };
}

/**
 * Starts a call at once, ringing, and checks while it rings: the call picks up when the check is
 * back, and is dropped with the reason when something it needs does not answer. The caller hands
 * over `start` and `end` so this file, loaded when a call is placed, never pulls the call session
 * into a chunk of its own.
 */
export async function dozoStartCall(
  call: Call,
  calls: { start: typeof startCall; end: () => void },
): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const checked = dozoCheckCall(call.botId);
    calls.start({
      ...call,
      check: checked.then(({ serverDictation }) => ({ serverDictation })),
    });
    const { refusal } = await checked;
    if (refusal) {
      calls.end();
      toastError(refusal);
    }
  } finally {
    checking = false;
  }
}
