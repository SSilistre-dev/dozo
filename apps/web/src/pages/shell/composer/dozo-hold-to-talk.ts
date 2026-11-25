import { useEffect, useId, useRef } from "react";
import { webSpeechAvailable } from "../../../lib/calls/dictation";
import { useEventListener } from "../../../lib/use-event-listener";
import { useHoldToTalk as useComposerHoldToTalk } from "./hold-to-talk";

export { HoldToTalkStrip } from "./hold-to-talk";

/**
 * What the fork's desktop shell sends the page when its push-to-talk shortcut goes down or up.
 * The shell has no bridge into the page: it dispatches this event on the window and nothing comes
 * back. Its detail is `"down"` or `"up"`.
 */
export const TALK_KEY_EVENT = "dozo-talk-key";

declare global {
  interface WindowEventMap {
    [TALK_KEY_EVENT]: CustomEvent<unknown>;
  }
}

/** The composers on screen, the newest last: only the newest one answers the shortcut. */
const composers: string[] = [];

/**
 * The composer's hold-to-talk, also driven by the desktop shortcut: down starts the same
 * dictation the microphone button starts (hands-free, as from the keyboard), up sends it. A
 * composer whose microphone is disabled, or that has nothing to turn speech into text (no voice
 * provider that transcribes and no recognizer in the web view), ignores it: the shortcut never
 * opens the microphone where talking could not work.
 */
export function useHoldToTalk(options: Parameters<typeof useComposerHoldToTalk>[0]) {
  const talk = useComposerHoldToTalk(options);
  const id = useId();
  const fromKey = useRef(false);
  useEffect(() => {
    composers.push(id);
    return () => {
      composers.splice(composers.lastIndexOf(id), 1);
    };
  }, [id]);
  // A recording that ended any other way is no longer the key's to send.
  useEffect(() => {
    if (!talk.recording) fromKey.current = false;
  }, [talk.recording]);
  useEventListener(typeof window === "undefined" ? null : window, TALK_KEY_EVENT, (event) => {
    if (composers.at(-1) !== id) return;
    if (event.detail === "down") {
      if (options.disabled || talk.recording) return;
      if (!options.transcribe && !webSpeechAvailable()) return;
      fromKey.current = true;
      talk.startHandsFree();
    } else if (event.detail === "up" && fromKey.current) {
      fromKey.current = false;
      talk.submit();
    }
  });
  return talk;
}
