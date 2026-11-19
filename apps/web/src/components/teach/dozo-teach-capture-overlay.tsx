import { teachCaptureKey } from "@rakazo/core";
import type { ComponentProps } from "react";
import { useEventListener } from "../../lib/use-event-listener";
import { closeTeachKeys, queueTeachKey, sendTeachKeysNow } from "./dozo-teach-key-batch";
import { TeachCaptureOverlay as UpstreamTeachCaptureOverlay } from "./TeachCaptureOverlay";

// The computer window opens after a recording starts and its dialog puts focus on a header
// button. Upstream ignores keys aimed at buttons and its pointerdown never moves focus, so the
// text typed right after clicking the screen would not be recorded. Clicking the screen means
// the person is now working on it: the page control lets go of focus first.
function releaseFocus() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
}

/** Keys aimed at page controls (Stop teaching, dialogs, protected input) are not the demo's. */
function aimedAtControl(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("button, input, textarea, select, a, [contenteditable]") !== null
  );
}

/**
 * Upstream's capture overlay, with keys typed on the screen sent in batches: upstream sends each
 * key as its own request, one after the other, so a word took seconds to reach the computer and
 * keys still queued were lost when the page closed. The keys are taken before upstream's own
 * listener sees them; a click, a scroll or protected input closes the batch so nothing overtakes
 * it, and keys not yet sent go out as the page is hidden.
 */
export function TeachCaptureOverlay(props: ComponentProps<typeof UpstreamTeachCaptureOverlay>) {
  const { botId, skill, enabled } = props;
  const capturing = enabled && skill?.status === "recording";
  const target = capturing ? window : null;

  useEventListener(
    target,
    "keydown",
    (event) => {
      if (aimedAtControl(event.target)) return;
      const key = teachCaptureKey(event.key, event);
      if (!key) return;
      event.preventDefault();
      // Upstream's window listener would send the key again, one request for it alone.
      event.stopImmediatePropagation();
      queueTeachKey(botId, key);
    },
    true,
  );
  // Protected input is sent from the recording's own form.
  useEventListener(target, "submit", () => closeTeachKeys(botId), true);
  useEventListener(target, "pagehide", () => sendTeachKeysNow());

  return (
    // `display: contents` leaves no box, so the overlay is positioned and hit-tested as before.
    <div
      style={{ display: "contents" }}
      onPointerDownCapture={() => {
        closeTeachKeys(botId);
        releaseFocus();
      }}
      onWheelCapture={() => closeTeachKeys(botId)}
    >
      <UpstreamTeachCaptureOverlay {...props} />
    </div>
  );
}
