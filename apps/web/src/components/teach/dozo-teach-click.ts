import { useTimeout } from "@rakazo/chat-ui/hooks";
import { DEFAULT_COMPUTER_SCREEN, mapTeachPointer } from "@rakazo/core";
import { useRef, useState } from "react";
import { rpc } from "../../lib/query/rpc";
import { useEventListener } from "../../lib/use-event-listener";
import { enqueueTeachComputerInput } from "./teach-computer-input-chain";

/** How far (in screen pixels) a press may move and still be a click; the recording's own rule. */
const DRAG_PX = 8;
/** How long the ring shows. */
const RING_MS = 450;

type Press = {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  button: "left" | "right";
  buttons: number;
  pointerId: number;
};

export type ClickRing = { id: number; left: number; top: number };

/** Events this hook made itself, so its own listeners let them through to upstream's. */
const own = new WeakSet<Event>();

function buttonOf(event: MouseEvent): "left" | "right" {
  return event.button === 2 ? "right" : "left";
}

/** A press the overlay's own listeners have not seen move: upstream gets it as a real press. */
function replayPress(target: HTMLElement, press: Press) {
  const init = {
    bubbles: true,
    cancelable: true,
    clientX: press.clientX,
    clientY: press.clientY,
    button: press.button === "right" ? 2 : 0,
    buttons: press.buttons,
    pointerId: press.pointerId,
  };
  const replay =
    typeof PointerEvent === "function"
      ? new PointerEvent("pointerdown", init)
      : new MouseEvent("pointerdown", init);
  own.add(replay);
  target.dispatchEvent(replay);
}

/**
 * A plain click is one `click` input instead of a press and a release: upstream sends each as its
 * own request, one after the other, so a click cost two round trips, two recording writes and two
 * actions on the computer. The press is held back until it is known to be a drag (it moved
 * `DRAG_PX` screen pixels, the recording's own line between a click and a drag) and is then
 * handed to upstream's listeners as if it had just happened; a press that stays put is sent once,
 * at the release, as a `click` at the spot it began, which is how the recording reads it anyway.
 * The ring shows at the press, before anything is sent, so the click is seen to land at once; a press that turns into a drag takes it away again.
 * Returns the ring to draw, or `null`.
 */
export function useTeachClick(
  botId: string,
  overlay: HTMLElement | null,
  screenWidth?: number,
  screenHeight?: number,
): ClickRing | null {
  const [ring, setRing] = useState<ClickRing | null>(null);
  const press = useRef<Press | null>(null);
  const rings = useRef(0);
  const width = screenWidth ?? DEFAULT_COMPUTER_SCREEN.width;
  const height = screenHeight ?? DEFAULT_COMPUTER_SCREEN.height;
  useTimeout(() => setRing(null), ring ? RING_MS : null, ring?.id);

  function screenPoint(event: MouseEvent, from: HTMLElement) {
    return mapTeachPointer(event.clientX, event.clientY, from.getBoundingClientRect(), {
      width,
      height,
    });
  }

  useEventListener(
    overlay,
    "pointerdown",
    (event) => {
      if (own.has(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const from = event.currentTarget as HTMLElement;
      from.setPointerCapture(event.pointerId);
      const at = screenPoint(event, from);
      press.current = {
        ...at,
        clientX: event.clientX,
        clientY: event.clientY,
        button: buttonOf(event),
        buttons: event.buttons,
        pointerId: event.pointerId,
      };
      const rect = from.getBoundingClientRect();
      setRing({ id: ++rings.current, left: event.clientX - rect.left, top: event.clientY - rect.top });
    },
    true,
  );
  useEventListener(
    overlay,
    "pointermove",
    (event) => {
      const held = press.current;
      if (!held || !event.buttons) return;
      const from = event.currentTarget as HTMLElement;
      const at = screenPoint(event, from);
      if (Math.hypot(at.x - held.x, at.y - held.y) >= DRAG_PX) {
        press.current = null;
        // A drag, not a click: no ring.
        setRing(null);
        replayPress(from, held);
        return;
      }
      event.stopImmediatePropagation();
    },
    true,
  );
  function endPress(event: PointerEvent, click: boolean) {
    const held = press.current;
    if (!held) return;
    press.current = null;
    event.preventDefault();
    event.stopImmediatePropagation();
    const from = event.currentTarget as HTMLElement;
    if (from.hasPointerCapture(event.pointerId)) from.releasePointerCapture(event.pointerId);
    if (!click) return;
    const { x, y, button } = held;
    void enqueueTeachComputerInput(botId, async () => {
      await rpc.computer.input({ botId, kind: "pointer", payload: { x, y, button, type: "click" } });
    });
  }
  useEventListener(overlay, "pointerup", (event) => endPress(event, true), true);
  useEventListener(overlay, "pointercancel", (event) => endPress(event, false), true);
  return ring;
}
