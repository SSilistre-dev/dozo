import type { DozoCharacter } from "@rakazo/core";
import {
  DOZO_AVATAR_ART,
  DOZO_BOT_PALETTE,
  DOZO_CHARACTERS,
  dozoCharacterForSeed,
  dozoHashSeed,
} from "@rakazo/core";
import type { AnimationEvent, CSSProperties, ReactNode } from "react";
import { createElement, Fragment, memo, useEffect, useRef } from "react";
import { cn } from "./lib/utils.js";
import "./dozo-avatar.css";

export { DOZO_CHARACTERS, dozoCharacterForSeed };
export type DozoAvatarState = "working" | "waiting" | "idle";

/** Below this size pointer tracking and idle motion are off: unreadable, and wasted frames. */
const MIN_MOTION_SIZE = 32;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/**
 * Draws a character from the shared art data (`DOZO_AVATAR_ART` in `@rakazo/core`, which also
 * holds the palette). Shapes that move together are grouped; children are passed by position, so
 * no element needs a key.
 */
function Art({ character }: { character: DozoCharacter }) {
  const groups: [part: "head" | "feature" | "eyes", nodes: ReactNode[]][] = [];
  for (const [part, tag, paint, attrs] of DOZO_AVATAR_ART[character]) {
    const node = createElement(tag, { className: `da-${paint}`, ...attrs });
    const last = groups[groups.length - 1];
    if (last?.[0] === part) last[1].push(node);
    else groups.push([part, [node]]);
  }
  return createElement(
    Fragment,
    null,
    ...groups.flatMap(([part, nodes]) => {
      if (part === "head") return nodes;
      if (part === "feature") return [createElement("g", { className: "da-feature" }, ...nodes)];
      const blink = createElement("g", { className: "da-blink" }, ...nodes);
      return [createElement("g", { className: "da-eyes" }, blink)];
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// One set of listeners, two observers and one animation-frame loop shared by every mounted avatar.
// The loop only runs while something moves; any event that can change a target wakes it again.

/** Per-instance state both the component and the shared loop read. */
interface Live {
  state: DozoAvatarState;
  /** Time (rAF clock) until which a hovered idle avatar stays awake; Infinity while hovered. */
  awakeUntil: number;
}

interface Tracker {
  live: Live;
  root: HTMLElement;
  eyes: SVGGElement;
  /** Largest eye shift in SVG units that stays inside the visor. */
  limit: readonly [number, number];
  x: number;
  y: number;
  open: number;
  cx: number;
  cy: number;
  applied: string;
  /** Mirrors data-awake on the root, which CSS reads to stop a sleeper blinking. */
  awake: boolean;
  /** Off-screen avatars are neither measured nor moved. */
  visible: boolean;
}

const EYE_LIMIT: Record<DozoCharacter, readonly [number, number]> = {
  sora: [3.2, 2.4],
  kumo: [3.2, 2],
  hana: [3.2, 2.4],
  taro: [2.8, 2.4],
  yuki: [3.4, 2.6],
  mochi: [3.4, 2],
};
const GAIN: Record<DozoAvatarState, number> = { working: 0.8, waiting: 1, idle: 0.8 };
const SLEEP_OPEN = 0.3;
const SLEEP_GAIN = 0.15;
const RANGE = 240;
const WAKE_HOLD_MS = 900;
/** Below these the eyes are visually at their target (the transform is written to 0.01 / 0.001). */
const SETTLED_SHIFT = 0.005;
const SETTLED_OPEN = 0.0005;

const trackers = new Map<HTMLElement, Tracker>();
/** One object mutated in place, so a pointer move allocates nothing. */
const pointer = { x: 0, y: 0, active: false };
let frame = 0;
let lastTime = 0;
let stale = true;
let reduced = false;
let resizeObserver: ResizeObserver | undefined;
let visibilityObserver: IntersectionObserver | undefined;
const watchedForVisibility = new Set<HTMLElement>();

const clamp = (value: number, max: number) => Math.max(-max, Math.min(max, value));
const isSleeping = (live: Live, now: number) => live.state === "idle" && now >= live.awakeUntil;

/** Starts a frame unless one is already queued or nothing is mounted. */
function wake() {
  if (frame || trackers.size === 0) return;
  lastTime = 0;
  frame = requestAnimationFrame(tick);
}

function onPointerMove(event: PointerEvent) {
  if (reduced) return;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.active = true;
  wake();
}
function onPointerAway() {
  pointer.active = false;
  wake();
}
function markStale() {
  stale = true;
  wake();
}
function onReducedMotionChange(event: MediaQueryListEvent) {
  reduced = event.matches;
  if (reduced) pointer.active = false;
  wake();
}

function onVisibilityChange(entries: IntersectionObserverEntry[]) {
  for (const { target, isIntersecting } of entries) {
    target.toggleAttribute("data-offscreen", !isIntersecting);
    // A paused hop never reaches animationend, which would leave it set and block the next hover.
    if (!isIntersecting) target.querySelector(".da-svg")?.classList.remove("is-hop");
    const tracker = trackers.get(target as HTMLElement);
    if (!tracker) continue;
    tracker.visible = isIntersecting;
    if (isIntersecting) markStale();
  }
}

/**
 * Pauses an avatar's CSS animations while it is off-screen. Without IntersectionObserver every
 * avatar counts as visible.
 */
function watchVisibility(root: HTMLElement): () => void {
  if (typeof IntersectionObserver !== "function") return () => undefined;
  visibilityObserver ??= new IntersectionObserver(onVisibilityChange);
  visibilityObserver.observe(root);
  watchedForVisibility.add(root);
  return () => {
    visibilityObserver?.unobserve(root);
    watchedForVisibility.delete(root);
    if (watchedForVisibility.size === 0) {
      visibilityObserver?.disconnect();
      visibilityObserver = undefined;
    }
  };
}

/**
 * The window and document subscriptions every avatar needs, attached once. This is a module-level
 * subscription and not a per-avatar hook because N avatars would otherwise attach N copies of the
 * same five listeners; the first tracked avatar connects it and the last one disconnects it.
 */
function connectSharedSources(): () => void {
  const query =
    typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : undefined;
  reduced = query?.matches ?? false;
  query?.addEventListener?.("change", onReducedMotionChange);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("blur", onPointerAway);
  window.addEventListener("resize", markStale);
  window.addEventListener("scroll", markStale, true);
  document.documentElement.addEventListener("pointerleave", onPointerAway);
  return () => {
    query?.removeEventListener?.("change", onReducedMotionChange);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("blur", onPointerAway);
    window.removeEventListener("resize", markStale);
    window.removeEventListener("scroll", markStale, true);
    document.documentElement.removeEventListener("pointerleave", onPointerAway);
    pointer.active = false;
  };
}

function measureOne(tracker: Tracker) {
  const rect = tracker.root.getBoundingClientRect();
  tracker.cx = rect.left + rect.width / 2;
  tracker.cy = rect.top + rect.height / 2;
}

function measure() {
  stale = false;
  for (const tracker of trackers.values()) {
    if (tracker.visible) measureOne(tracker);
  }
}

function tick(now: number) {
  frame = 0;
  const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0.016;
  lastTime = now;
  // Reduced motion: the eyes take their target at once, with no eased frames in between.
  const follow = reduced ? 1 : 1 - Math.exp(-dt * 10);
  const wakeRate = reduced ? 1 : 1 - Math.exp(-dt * 5);
  // With no pointer nothing can move toward it, so positions stay stale until one appears.
  if (stale && pointer.active) measure();
  let moving = false;
  for (const t of trackers.values()) {
    if (!t.visible) continue;
    const sleeping = isSleeping(t.live, now);
    if (!sleeping !== t.awake) {
      t.awake = !sleeping;
      t.root.toggleAttribute("data-awake", t.awake);
    }
    const gain = sleeping ? SLEEP_GAIN : GAIN[t.live.state];
    const tx = pointer.active ? clamp((pointer.x - t.cx) / RANGE, 1) * t.limit[0] * gain : 0;
    const ty = pointer.active ? clamp((pointer.y - t.cy) / RANGE, 1) * t.limit[1] * gain : 0;
    const open = sleeping ? SLEEP_OPEN : 1;
    t.x += (tx - t.x) * follow;
    t.y += (ty - t.y) * follow;
    t.open += (open - t.open) * wakeRate;
    if (
      Math.abs(tx - t.x) < SETTLED_SHIFT &&
      Math.abs(ty - t.y) < SETTLED_SHIFT &&
      Math.abs(open - t.open) < SETTLED_OPEN
    ) {
      t.x = tx;
      t.y = ty;
      t.open = open;
    } else {
      moving = true;
    }
    // A hovered idle avatar that has just been left falls asleep on a deadline, not on an event.
    if (t.live.state === "idle" && t.live.awakeUntil > now && t.live.awakeUntil !== Infinity) {
      moving = true;
    }
    const transform = `translate(${t.x.toFixed(2)}px,${t.y.toFixed(2)}px) scaleY(${t.open.toFixed(3)})`;
    if (transform !== t.applied) {
      t.eyes.style.transform = transform;
      t.applied = transform;
    }
  }
  if (moving) frame = requestAnimationFrame(tick);
}

let disconnectSources: (() => void) | undefined;

function track(tracker: Tracker): () => void {
  if (trackers.size === 0) {
    disconnectSources = connectSharedSources();
    if (typeof ResizeObserver === "function") resizeObserver = new ResizeObserver(markStale);
  }
  trackers.set(tracker.root, tracker);
  resizeObserver?.observe(tracker.root);
  markStale();
  return () => {
    // A rebuilt tracker starts asleep and unwritten, so leave neither mark of this one behind.
    tracker.root.removeAttribute("data-awake");
    tracker.eyes.style.removeProperty("transform");
    trackers.delete(tracker.root);
    resizeObserver?.unobserve(tracker.root);
    if (trackers.size > 0) return;
    cancelAnimationFrame(frame);
    frame = 0;
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    disconnectSources?.();
    disconnectSources = undefined;
  };
}

export interface DozoAvatarProps {
  /** Stable identity (bot id or name). Picks the character, and its colour unless `color` is set. */
  seed: string;
  /** The character to draw, when something other than the seed decides it. */
  character?: DozoCharacter;
  /** Explicit accessory colour, a hex value (the bot's `color` field). The character stays seed-based. */
  color?: string;
  size?: number;
  state?: DozoAvatarState;
  className?: string;
  /** Accessible label. Without it the avatar is decorative. */
  title?: string;
  /** Eyes follow the pointer and the avatar reacts to hover. Turn off for dense lists. */
  interactive?: boolean;
}

export const DozoAvatar = memo(function DozoAvatar({
  seed,
  character = dozoCharacterForSeed(seed),
  color,
  size = 36,
  state = "idle",
  className,
  title,
  interactive = true,
}: DozoAvatarProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const live = useRef<Live>({ state, awakeUntil: 0 });

  const full = size >= MIN_MOTION_SIZE;
  const tracking = interactive && full;
  const hash = dozoHashSeed(seed);
  // Each avatar blinks on its own period and phase, so a list never blinks in unison.
  const blinkPeriod = 4 + ((hash >>> 8) % 20) / 10;
  const [light, dark] = DOZO_BOT_PALETTE[character];
  const style = {
    width: size,
    height: size,
    "--dozo-delay": `${-((hash % 30) / 10)}s`,
    "--dozo-blink-period": `${blinkPeriod}s`,
    "--dozo-blink-delay": `${-(((hash >>> 16) % 100) / 100) * blinkPeriod}s`,
    // The character's colour: its accessory, and the tint dozo-shell.css gives the open bot's row
    // (which reads this name, kept from the tile the colour once filled). light-dark() follows the
    // theme's color-scheme; an explicit hex colour wins.
    "--dozo-tile": color && HEX_COLOR.test(color) ? color : `light-dark(${light}, ${dark})`,
  } as CSSProperties;

  useEffect(() => {
    live.current.state = state;
    wake();
  }, [state]);

  useEffect(() => {
    const root = rootRef.current;
    return root ? watchVisibility(root) : undefined;
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const eyes = root?.querySelector<SVGGElement>(".da-eyes");
    if (!tracking || !root || !eyes) {
      // The hover handlers are gone, so no leave will come: a hold set by an earlier hover ends here.
      live.current.awakeUntil = 0;
      return;
    }
    const open = live.current.state === "idle" ? SLEEP_OPEN : 1;
    return track({
      live: live.current,
      root,
      eyes,
      limit: EYE_LIMIT[character],
      x: 0,
      y: 0,
      open,
      cx: 0,
      cy: 0,
      applied: "",
      awake: false,
      visible: !root.hasAttribute("data-offscreen"),
    });
  }, [tracking, character]);

  const onEnter = () => {
    live.current.awakeUntil = Infinity;
    // The layout may have shifted without a scroll or resize; measure this avatar again before aiming.
    const tracker = rootRef.current && trackers.get(rootRef.current);
    if (tracker) measureOne(tracker);
    wake();
    if (!reduced) svgRef.current?.classList.add("is-hop");
  };
  const onLeave = () => {
    live.current.awakeUntil = performance.now() + WAKE_HOLD_MS;
    wake();
  };
  const onAnimationEnd = (event: AnimationEvent<SVGSVGElement>) => {
    if (event.target === event.currentTarget) event.currentTarget.classList.remove("is-hop");
  };
  // React has no prop for animationcancel, which ends a hop that animationend never reports.
  useEffect(() => {
    const svg = svgRef.current;
    const clear = () => svg?.classList.remove("is-hop");
    svg?.addEventListener("animationcancel", clear);
    return () => svg?.removeEventListener("animationcancel", clear);
  }, []);

  return (
    <span
      ref={rootRef}
      className={cn("dozo-avatar", `dozo-avatar-${state}`, className)}
      data-character={character}
      data-state={state}
      data-motion={full ? "full" : "still"}
      style={style}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
      onPointerEnter={tracking ? onEnter : undefined}
      onPointerLeave={tracking ? onLeave : undefined}
    >
      <svg
        ref={svgRef}
        className="da-svg"
        viewBox="0 0 64 64"
        aria-hidden="true"
        onAnimationEnd={onAnimationEnd}
      >
        <g className="da-head">
          <Art character={character} />
        </g>
      </svg>
    </span>
  );
});
