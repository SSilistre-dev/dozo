import type { ComponentProps } from "react";
import { TeachCaptureOverlay as UpstreamTeachCaptureOverlay } from "./TeachCaptureOverlay";

// The computer window opens after a recording starts and its dialog puts focus on a header
// button. Upstream ignores keys aimed at buttons and its pointerdown never moves focus, so the
// text typed right after clicking the screen would not be recorded. Clicking the screen means
// the person is now working on it: the page control lets go of focus first.
function releaseFocus() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
}

export function TeachCaptureOverlay(props: ComponentProps<typeof UpstreamTeachCaptureOverlay>) {
  return (
    // `display: contents` leaves no box, so the overlay is positioned and hit-tested as before.
    <div style={{ display: "contents" }} onPointerDownCapture={releaseFocus}>
      <UpstreamTeachCaptureOverlay {...props} />
    </div>
  );
}
