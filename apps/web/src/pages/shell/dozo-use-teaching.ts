import { useCallback, useRef, useState } from "react";
import { enqueueTeachComputerInput } from "../../components/teach/teach-computer-input-chain";
import { useTeaching as upstreamUseTeaching } from "./use-teaching";

/**
 * Upstream's teaching hook, except that Stop first waits for the bot's input still on its way to
 * the computer. The clicks and keys of a recording are sent one after another; a stop sent past
 * them ends the recording first, and the server drops what arrives later, so the last value typed
 * would be cut short and its Enter lost.
 */
export function useTeaching(options: Parameters<typeof upstreamUseTeaching>[0]) {
  const teaching = upstreamUseTeaching(options);
  const { stopTeaching } = teaching;
  const [waiting, setWaiting] = useState(false);
  const waitingRef = useRef(false);
  const stop = useCallback(async () => {
    const id = options.activeBotId.current;
    if (!id || waitingRef.current) return;
    waitingRef.current = true;
    setWaiting(true);
    try {
      // The chain never rejects past a task, so this settles once the queued input has.
      await enqueueTeachComputerInput(id, async () => undefined);
    } finally {
      waitingRef.current = false;
      setWaiting(false);
    }
    await stopTeaching();
  }, [stopTeaching]);
  return { ...teaching, teachBusy: teaching.teachBusy || waiting, stopTeaching: stop };
}
