import type { AnimationEvent, CSSProperties, ReactNode } from "react";
import { memo, useEffect, useRef } from "react";
import { cn } from "./lib/utils.js";
import "./dozo-avatar.css";

export const DOZO_CHARACTERS = ["sora", "kumo", "hana", "taro", "yuki", "mochi"] as const;
export type DozoCharacter = (typeof DOZO_CHARACTERS)[number];
export type DozoAvatarState = "working" | "waiting" | "idle";

/** Below this size pointer tracking and idle motion are off: unreadable, and wasted frames. */
const MIN_MOTION_SIZE = 32;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A seed that is a character's own name gets that character; any other seed is hashed. */
export function dozoCharacterForSeed(seed: string): DozoCharacter {
  const key = seed.trim().toLowerCase();
  return (
    DOZO_CHARACTERS.find((name) => name === key) ??
    (DOZO_CHARACTERS[hashSeed(key) % DOZO_CHARACTERS.length] as DozoCharacter)
  );
}

/**
 * The Dozo bot identity palette, the only place the avatar's identity colours are written down:
 * a tile colour (light page, dark page) and an eye glow per character. Upstream's `botColors` and
 * `botEyeColor` in `@rakazo/ui-tokens` could not be used: they are TypeScript-only values, hold
 * seven colours (#3EC5A8 #F5A03C #6A6BF5 #9B5CF6 #3B82F6 #F2622A #D9508A) instead of six with other
 * hues (indigo, pink and orange where ours are green, amber and coral), and the eye ink is one dark
 * #101014, while these eyes glow light on a dark visor. The component sets them inline on its root.
 */
const DOZO_BOT_PALETTE: Record<
  DozoCharacter,
  { readonly tile: readonly [light: string, dark: string]; readonly glow: string }
> = {
  sora: { tile: ["#3f7fcb", "#4f8fd8"], glow: "#bfe0ff" },
  kumo: { tile: ["#8f6bcb", "#a07ed8"], glow: "#e2d6ff" },
  hana: { tile: ["#3f9468", "#4fa37a"], glow: "#c4f2d9" },
  taro: { tile: ["#c4872f", "#d19a45"], glow: "#ffe2ae" },
  yuki: { tile: ["#d26a59", "#dc7a6a"], glow: "#ffd0c6" },
  mochi: { tile: ["#2f9297", "#3fa3a8"], glow: "#b8f0f0" },
};

// ---------------------------------------------------------------------------------------------
// Drawings, ported from design/d/dozo.js. Colours live in DOZO_BOT_PALETTE above, not here.

function Eyes({ children }: { children: ReactNode }) {
  return (
    <g className="da-eyes">
      <g className="da-blink">{children}</g>
    </g>
  );
}

function Art({ character }: { character: DozoCharacter }) {
  switch (character) {
    case "sora":
      return (
        <>
          <rect className="da-body" x="30.5" y="9" width="3" height="10" rx="1.5" />
          <g className="da-feature">
            <circle className="da-glow" cx="32" cy="9" r="3.5" />
          </g>
          <circle className="da-body" cx="32" cy="36" r="18" />
          <rect className="da-visor" x="20" y="30" width="24" height="13" rx="6.5" />
          <Eyes>
            <circle className="da-glow" cx="27" cy="36.5" r="2.6" />
            <circle className="da-glow" cx="37" cy="36.5" r="2.6" />
          </Eyes>
        </>
      );
    case "kumo":
      return (
        <>
          <g className="da-feature">
            <rect className="da-body" x="22" y="11" width="3" height="10" rx="1.5" />
            <rect className="da-body" x="39" y="11" width="3" height="10" rx="1.5" />
          </g>
          <rect className="da-body" x="15" y="20" width="34" height="30" rx="9" />
          <rect className="da-visor" x="20" y="28" width="24" height="14" rx="5" />
          <Eyes>
            <rect className="da-glow" x="23.5" y="34.5" width="6" height="3" rx="1.5" />
            <rect className="da-glow" x="34.5" y="34.5" width="6" height="3" rx="1.5" />
          </Eyes>
        </>
      );
    case "hana":
      return (
        <>
          <rect className="da-body" x="30" y="17" width="4" height="8" />
          <g className="da-feature">
            <circle className="da-glow" cx="32" cy="15" r="3.5" />
          </g>
          <rect className="da-body" x="10" y="24" width="44" height="26" rx="13" />
          <rect className="da-visor" x="16" y="30" width="32" height="14" rx="7" />
          <Eyes>
            <rect className="da-glow" x="21" y="35.2" width="22" height="3.6" rx="1.8" />
          </Eyes>
        </>
      );
    case "taro":
      return (
        <>
          <rect className="da-body" x="18" y="12" width="28" height="42" rx="13" />
          <g className="da-feature">
            <rect className="da-band" x="18" y="26" width="28" height="4" />
          </g>
          <rect className="da-visor" x="22" y="33" width="20" height="15" rx="7" />
          <Eyes>
            <ellipse className="da-glow" cx="28" cy="40.5" rx="2.3" ry="3.3" />
            <ellipse className="da-glow" cx="36" cy="40.5" rx="2.3" ry="3.3" />
          </Eyes>
        </>
      );
    case "yuki":
      return (
        <>
          <g className="da-feature">
            <circle className="da-body" cx="12" cy="35" r="4.5" />
            <circle className="da-body" cx="52" cy="35" r="4.5" />
          </g>
          <rect className="da-body" x="14" y="18" width="36" height="34" rx="16" />
          <rect className="da-visor" x="19" y="27" width="26" height="15" rx="7.5" />
          <Eyes>
            <circle className="da-glow" cx="27" cy="34.5" r="2.7" />
            <path className="da-glow-line" d="M33.5 35q3.5-3.4 7 0" />
          </Eyes>
        </>
      );
    case "mochi":
      return (
        <>
          <g className="da-feature">
            <ellipse
              className="da-glow"
              cx="41"
              cy="13"
              rx="3"
              ry="8.5"
              transform="rotate(28 41 13)"
            />
          </g>
          <rect className="da-body" x="15" y="21" width="34" height="30" rx="11" />
          <rect className="da-visor" x="20" y="29" width="24" height="14" rx="7" />
          <Eyes>
            <path className="da-glow-line" d="M24 38q3-5 6 0M34 38q3-5 6 0" />
          </Eyes>
        </>
      );
  }
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
  sora: [3.2, 2.6],
  kumo: [2.5, 3],
  hana: [3.5, 2],
  taro: [2.7, 3],
  yuki: [3.5, 3],
  mochi: [2, 2.5],
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

function measure() {
  stale = false;
  for (const tracker of trackers.values()) {
    if (!tracker.visible) continue;
    const rect = tracker.root.getBoundingClientRect();
    tracker.cx = rect.left + rect.width / 2;
    tracker.cy = rect.top + rect.height / 2;
  }
}

function tick(now: number) {
  frame = 0;
  const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0.016;
  lastTime = now;
  const follow = 1 - Math.exp(-dt * 10);
  const wakeRate = 1 - Math.exp(-dt * 5);
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
  /** Stable identity (bot id or name). Picks the character, and the tile colour unless `color` is set. */
  seed: string;
  /** Explicit tile colour, a hex value (the bot's `color` field). The character stays seed-based. */
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

  const character = dozoCharacterForSeed(seed);
  const full = size >= MIN_MOTION_SIZE;
  const tracking = interactive && full;
  const hash = hashSeed(seed);
  // Each avatar blinks on its own period and phase, so a list never blinks in unison.
  const blinkPeriod = 4 + ((hash >>> 8) % 20) / 10;
  const [tileLight, tileDark] = DOZO_BOT_PALETTE[character].tile;
  const style = {
    width: size,
    height: size,
    "--dozo-delay": `${-((hash % 30) / 10)}s`,
    "--dozo-blink-period": `${blinkPeriod}s`,
    "--dozo-blink-delay": `${-(((hash >>> 16) % 100) / 100) * blinkPeriod}s`,
    // light-dark() follows the theme's color-scheme; an explicit hex colour wins over the tile.
    "--dozo-tile": color && HEX_COLOR.test(color) ? color : `light-dark(${tileLight}, ${tileDark})`,
    "--dozo-glow": DOZO_BOT_PALETTE[character].glow,
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
    if (!tracking || !root || !eyes) return;
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
    // The layout may have shifted without a scroll or resize; measure again before aiming.
    markStale();
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
        <rect className="da-tile" width="64" height="64" rx="18" />
        <g className="da-head">
          <Art character={character} />
        </g>
      </svg>
    </span>
  );
});
