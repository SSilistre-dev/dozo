import { t } from "@lingui/core/macro";
import type { DozoCallCheck } from "@rakazo/contracts";
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
 * Asks whether a call to this bot can start: the reason it cannot, in the words the person sees,
 * and whether the speech server hears the caller. A check that cannot be made refuses nothing,
 * so the call itself then reports what is wrong.
 */
export async function dozoCheckCall(
  botId: string,
): Promise<{ refusal: string | null; serverDictation: boolean | undefined }> {
  let check: DozoCallCheck | null = null;
  try {
    check = await rpc.dozoCallPreflight.check({ botId });
  } catch (error) {
    reportClientError(error, "voice.turn");
  }
  return { refusal: dozoCallRefusal(check), serverDictation: check?.serverDictation };
}

/**
 * Starts a call once the places it needs have answered. The caller hands over `start` so this
 * file, loaded when a call is placed, never pulls the call session into a chunk of its own.
 */
export async function dozoStartCall(call: Call, start: typeof startCall): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const { refusal, serverDictation } = await dozoCheckCall(call.botId);
    if (refusal) {
      toastError(refusal);
      return;
    }
    start({ ...call, serverDictation });
  } finally {
    checking = false;
  }
}
