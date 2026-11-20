import type { RelaySessionRefusal } from "@rakazo/contracts";
import {
  RELAY_SESSION_PATH,
  RelaySessionRefusalSchema,
  RelaySessionSchema,
} from "@rakazo/contracts";
import { Platform } from "react-native";
import type { PendingSignOut } from "./api";
import {
  currentApiBase,
  deliverSignOutRecord,
  endpointChangeInProgress,
  savePendingSignOut,
} from "./api";
import { clearSpace } from "./api-server";
import { currentSessionGeneration, saveSessionToken } from "./session";

/**
 * A paired phone's sign-in, asked of the computer it is paired with
 * (`packages/auth/src/dozo-relay-session.ts`). The computer gives one only while its account is
 * signed in there, only once per pairing, and only after the user approved this phone on the
 * computer; the computer holds the request until then. The phone asks whenever the sign-in screen
 * shows or comes back to the front.
 */
export type ComputerSignIn = "signed-in" | RelaySessionRefusal | "unreachable";

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function askComputerForSignIn(): Promise<ComputerSignIn> {
  const apiBase = currentApiBase();
  const generation = currentSessionGeneration();
  let response: Response;
  try {
    response = await fetch(`${apiBase}${RELAY_SESSION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "rakazo://" },
      // Shown on the computer beside the code, so the user knows which phone asks.
      body: JSON.stringify({
        platform: Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : undefined,
      }),
    });
  } catch (error) {
    if (error instanceof TypeError) return "unreachable";
    throw error;
  }
  const body = await readJson(response);
  const refusal = RelaySessionRefusalSchema.safeParse(body);
  if (!response.ok) return refusal.success ? refusal.data.reason : "unreachable";
  const session = RelaySessionSchema.safeParse(body);
  if (!session.success) return "unreachable";

  // As a password sign-in saves its session: never for a server the app has left meanwhile.
  const current = () =>
    apiBase === currentApiBase() &&
    generation === currentSessionGeneration() &&
    !endpointChangeInProgress();
  if (current() && (await clearSpace()) && current()) {
    await saveSessionToken(session.data.token);
    if (currentSessionGeneration() === generation + 1 && apiBase === currentApiBase()) {
      return "signed-in";
    }
  }
  // The session went to a server the app no longer uses: it is ended there, now or later.
  const revocation: PendingSignOut = {
    apiBase,
    token: session.data.token,
    headers: {},
    recordedAt: Date.now(),
  };
  void deliverSignOutRecord(revocation, await savePendingSignOut(revocation));
  return "unreachable";
}
