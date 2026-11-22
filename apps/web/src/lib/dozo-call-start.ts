import { t } from "@lingui/core/macro";
import type { DozoCallCheck } from "@rakazo/contracts";
import { startCall } from "./call-session";
import { desktopBridge } from "./desktop";
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
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (offline && !check.serverDictation && !desktopBridge()?.speech) {
    return t`Can't call: no internet and no speech recognition on this device.`;
  }
  return null;
}

/**
 * Starts a call once the places it needs have answered. A check that cannot be made starts the
 * call as it always did: the call itself then reports what is wrong.
 */
export async function dozoStartCall(call: Call): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    let check: DozoCallCheck | null = null;
    try {
      check = await rpc.dozoCallPreflight.check({ botId: call.botId });
    } catch (error) {
      reportClientError(error, "voice.turn");
    }
    const refusal = dozoCallRefusal(check);
    if (refusal) {
      toastError(refusal);
      return;
    }
    startCall({ ...call, serverDictation: check?.serverDictation });
  } finally {
    checking = false;
  }
}
