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

/** Call from effects and event handlers only: it reads window. */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;
}

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
    DOZO_CHARACTERS[hashSeed(key) % DOZO_CHARACTERS.length] ??
    "sora"
  );
}

// ---------------------------------------------------------------------------------------------
// Drawings, ported from design/d/dozo.js. Colours live in dozo-avatar.css, not here.

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
// One pointer listener and one animation-frame loop shared by every mounted avatar.

/** Per-instance state both the component and the shared loop read. */
interface Live {
  state: DozoAvatarState;
  awake: boolean;
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

const trackers = new Set<Tracker>();
let pointer: { x: number; y: number } | null = null;
let frame = 0;
let lastTime = 0;
let stale = true;
let slow = false;

const clamp = (value: number, max: number) => Math.max(-max, Math.min(max, value));
const isSleeping = (live: Live) => live.state === "idle" && !live.awake;

function onPointerMove(event: PointerEvent) {
  pointer = { x: event.clientX, y: event.clientY };
}
function onPointerAway() {
  pointer = null;
}
function markStale() {
  stale = true;
}

function measure() {
  stale = false;
  for (const tracker of trackers) {
    const rect = tracker.root.getBoundingClientRect();
    tracker.cx = rect.left + rect.width / 2;
    tracker.cy = rect.top + rect.height / 2;
  }
}

function tick(now: number) {
  const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0.016;
  lastTime = now;
  const follow = 1 - Math.exp(-dt * (slow ? 3 : 10));
  const wake = 1 - Math.exp(-dt * 5);
  if (stale) measure();
  for (const t of trackers) {
    const sleeping = isSleeping(t.live);
    const gain = sleeping ? SLEEP_GAIN : GAIN[t.live.state];
    const tx = pointer ? clamp((pointer.x - t.cx) / RANGE, 1) * t.limit[0] * gain : 0;
    const ty = pointer ? clamp((pointer.y - t.cy) / RANGE, 1) * t.limit[1] * gain : 0;
    t.x += (tx - t.x) * follow;
    t.y += (ty - t.y) * follow;
    t.open += ((sleeping ? SLEEP_OPEN : 1) - t.open) * wake;
    const transform = `translate(${t.x.toFixed(2)}px,${t.y.toFixed(2)}px) scaleY(${t.open.toFixed(3)})`;
    if (transform !== t.applied) {
      t.eyes.style.transform = transform;
      t.applied = transform;
    }
  }
  frame = requestAnimationFrame(tick);
}

function startLoop() {
  slow = prefersReducedMotion();
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("blur", onPointerAway);
  window.addEventListener("resize", markStale);
  window.addEventListener("scroll", markStale, true);
  document.documentElement.addEventListener("pointerleave", onPointerAway);
  lastTime = 0;
  frame = requestAnimationFrame(tick);
}

function stopLoop() {
  cancelAnimationFrame(frame);
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("blur", onPointerAway);
  window.removeEventListener("resize", markStale);
  window.removeEventListener("scroll", markStale, true);
  document.documentElement.removeEventListener("pointerleave", onPointerAway);
  pointer = null;
}

function track(tracker: Tracker): () => void {
  if (trackers.size === 0) startLoop();
  trackers.add(tracker);
  stale = true;
  return () => {
    trackers.delete(tracker);
    if (trackers.size === 0) stopLoop();
  };
}

// ---------------------------------------------------------------------------------------------

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
  const live = useRef<Live>({ state, awake: false });
  const wakeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const character = dozoCharacterForSeed(seed);
  const full = size >= MIN_MOTION_SIZE;
  const tracking = interactive && full;
  const style = {
    width: size,
    height: size,
    "--dozo-delay": `${-((hashSeed(seed) % 30) / 10)}s`,
    ...(color && HEX_COLOR.test(color) ? { "--dozo-tile": color } : {}),
  } as CSSProperties;

  useEffect(() => {
    live.current.state = state;
  }, [state]);

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
    });
  }, [tracking, character]);

  // Blinking runs for every size; it is cheap and the only motion a tiny avatar keeps.
  useEffect(() => {
    const blink = rootRef.current?.querySelector(".da-blink");
    if (!blink) return;
    const duration = prefersReducedMotion() ? 220 : 120;
    const gap = () => (Math.random() < 0.2 ? 260 : 2500 + Math.random() * 3500);
    let timer: ReturnType<typeof setTimeout>;
    const wait = (ms: number) => {
      timer = setTimeout(fire, ms);
    };
    const fire = () => {
      if (full && isSleeping(live.current)) return wait(gap());
      blink.classList.add("is-blinking");
      timer = setTimeout(() => {
        blink.classList.remove("is-blinking");
        wait(gap());
      }, duration);
    };
    wait(800 + Math.random() * 3200);
    return () => {
      clearTimeout(timer);
      blink.classList.remove("is-blinking");
    };
  }, [full]);

  useEffect(() => () => clearTimeout(wakeTimer.current), []);

  const onEnter = () => {
    clearTimeout(wakeTimer.current);
    live.current.awake = true;
    if (!prefersReducedMotion()) svgRef.current?.classList.add("is-hop");
  };
  const onLeave = () => {
    clearTimeout(wakeTimer.current);
    wakeTimer.current = setTimeout(() => {
      live.current.awake = false;
    }, 900);
  };
  const onAnimationEnd = (event: AnimationEvent<SVGSVGElement>) => {
    if (event.target === event.currentTarget) event.currentTarget.classList.remove("is-hop");
  };

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
