import { teachCaptureKey } from "@rakazo/core";
import type { ComponentProps } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { useEventListener } from "../../lib/use-event-listener";
import { useTeachClick } from "./dozo-teach-click";
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

/** An Escape inside one of these belongs to that popup, as upstream's own listener leaves it. */
const POPUP_SELECTOR = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

/** Keys aimed at page controls (Stop teaching, dialogs, protected input) are not the demo's. */
function aimedAtControl(event: KeyboardEvent): boolean {
  const { target } = event;
  if (!(target instanceof HTMLElement)) return false;
  if (event.key === "Escape" && target.closest(POPUP_SELECTOR)) return true;
  return target.closest("button, input, textarea, select, a, [contenteditable]") !== null;
}

/**
 * Takes the typed keys for the batch. Upstream listens for keys on the window in the capture phase
 * too, and listeners on one target run in the order they were added: this is rendered before the
 * overlay so its effect, which adds the listener, runs first and can stop upstream's from sending
 * each key again on its own.
 */
function TeachKeyTaker({ botId, target }: { botId: string; target: Window | null }) {
  useEventListener(
    target,
    "keydown",
    (event) => {
      if (aimedAtControl(event)) return;
      const key = teachCaptureKey(event.key, event);
      if (!key) return;
      event.preventDefault();
      // Upstream's window listener would send the key again, one request for it alone.
      event.stopImmediatePropagation();
      queueTeachKey(botId, key);
    },
    true,
  );
  return null;
}

/**
 * Upstream's capture overlay, with keys typed on the screen sent in batches: upstream sends each
 * key as its own request, one after the other, so a word took seconds to reach the computer and
 * keys still queued were lost when the page closed. The keys are taken before upstream's own
 * listener sees them; a click, a scroll or protected input closes the batch so nothing overtakes
 * it, and keys not yet sent go out as the page is hidden. A click is one input, not a press and a
 * release, and shows a ring where it landed (`dozo-teach-click.ts`).
 */
export function TeachCaptureOverlay(props: ComponentProps<typeof UpstreamTeachCaptureOverlay>) {
  const { botId, skill, enabled } = props;
  const capturing = enabled && skill?.status === "recording";
  const target = capturing ? window : null;
  const wrapper = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState<HTMLElement | null>(null);
  // Upstream's overlay is a child, already in place when this runs.
  useLayoutEffect(() => {
    setOverlay(
      capturing
        ? (wrapper.current?.querySelector<HTMLElement>('[data-testid="teach-capture-overlay"]') ??
            null)
        : null,
    );
  }, [capturing]);
  const ring = useTeachClick(botId, skill?.id, overlay, props.screenWidth, props.screenHeight);

  // Protected input is sent from the recording's own form.
  useEventListener(target, "submit", () => closeTeachKeys(botId), true);
  useEventListener(target, "pagehide", () => sendTeachKeysNow());

  return (
    // `display: contents` leaves no box, so the overlay is positioned and hit-tested as before.
    <div
      ref={wrapper}
      style={{ display: "contents" }}
      onPointerDownCapture={() => {
        closeTeachKeys(botId);
        releaseFocus();
      }}
      onWheelCapture={() => closeTeachKeys(botId)}
    >
      <TeachKeyTaker botId={botId} target={target} />
      <UpstreamTeachCaptureOverlay {...props} />
      {ring ? (
        <span
          key={ring.id}
          data-testid="teach-click-ring"
          aria-hidden="true"
          className="dozo-teach-ring"
          style={{ left: ring.left, top: ring.top }}
        />
      ) : null}
    </div>
  );
}
