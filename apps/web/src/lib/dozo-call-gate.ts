import type { startCall } from "./call-session";
import { reportClientError } from "./monitoring";

/**
 * The two ways into the call check, which load it when a call is placed or answered. They stay in
 * the first page's chunk because they are small; the check itself is not. A check that cannot be
 * loaded (a deploy moved its file under an open tab) never stops a call: the call goes as it did
 * before there was a check, and the failure is reported.
 */
const loadCallStart = () => import("./dozo-call-start");

/** Places a call through the check, or straight when the check cannot be loaded. */
export async function placeCall(
  call: Parameters<typeof startCall>[0],
  calls: { start: typeof startCall; end: () => void },
  load: typeof loadCallStart = loadCallStart,
): Promise<void> {
  let module: Awaited<ReturnType<typeof loadCallStart>>;
  try {
    module = await load();
  } catch (error) {
    reportClientError(error, "voice.turn");
    calls.start(call);
    return;
  }
  await module.dozoStartCall(call, calls);
}

/** What the check says before an incoming call is answered; nothing refused when it cannot load. */
export async function checkBeforeAnswer(
  botId: string,
  load: typeof loadCallStart = loadCallStart,
): Promise<{ refusal: string | null; serverDictation: boolean | undefined }> {
  try {
    return await (await load()).dozoCheckCall(botId);
  } catch (error) {
    reportClientError(error, "voice.turn");
    return { refusal: null, serverDictation: undefined };
  }
}
