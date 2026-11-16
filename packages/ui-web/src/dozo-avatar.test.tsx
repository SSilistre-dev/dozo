// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOZO_CHARACTERS, DozoAvatar, dozoCharacterForSeed } from "./dozo-avatar.js";

const MOCKUP_SEEDS = ["sora", "kumo", "hana", "taro", "yuki", "mochi"];

const mounted: Array<() => void> = [];

function mount(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  let done = false;
  const unmount = () => {
    if (done) return;
    done = true;
    act(() => root.unmount());
    container.remove();
  };
  mounted.push(unmount);
  return { container, unmount };
}

function pointerMoveAdds(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([type]) => type === "pointermove").length;
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DozoAvatar identity", () => {
  it("picks the same character for the same seed", () => {
    for (const seed of ["bot-1", "bot-2", "a long bot name", ""]) {
      expect(dozoCharacterForSeed(seed)).toBe(dozoCharacterForSeed(seed));
      expect(DOZO_CHARACTERS).toContain(dozoCharacterForSeed(seed));
    }
    const a = renderToString(<DozoAvatar seed="bot-1" />);
    const b = renderToString(<DozoAvatar seed="bot-1" />);
    expect(a).toBe(b);
  });

  it("maps the six mockup seeds to six distinct characters", () => {
    const characters = MOCKUP_SEEDS.map((seed) => dozoCharacterForSeed(seed));
    expect(new Set(characters).size).toBe(6);
    expect(characters).toEqual(MOCKUP_SEEDS);
    expect(dozoCharacterForSeed("Sora")).toBe("sora");
  });

  it("spreads other seeds over every character", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => dozoCharacterForSeed(`bot-${i}`)));
    expect(seen.size).toBe(6);
  });

  it("gives each character its own tile colour for both themes and its own eye glow", () => {
    const tiles = new Set<string | undefined>();
    const glows = new Set<string | undefined>();
    for (const seed of MOCKUP_SEEDS) {
      const html = renderToString(<DozoAvatar seed={seed} />);
      expect(html).toContain(`data-character="${seed}"`);
      const tile = html.match(/--dozo-tile:(light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\))/i)?.[1];
      const glow = html.match(/--dozo-glow:(#[0-9a-f]{6})/i)?.[1];
      expect(tile).toBeDefined();
      expect(glow).toBeDefined();
      tiles.add(tile);
      glows.add(glow);
    }
    expect(tiles.size).toBe(6);
    expect(glows.size).toBe(6);
  });

  it("respects an explicit colour and keeps the seed-based character", () => {
    const plain = renderToString(<DozoAvatar seed="bot-7" />);
    const painted = renderToString(<DozoAvatar seed="bot-7" color="#ff00aa" />);
    const character = dozoCharacterForSeed("bot-7");
    expect(plain).toContain(`data-character="${character}"`);
    expect(painted).toContain(`data-character="${character}"`);
    expect(painted).toContain("--dozo-tile:#ff00aa");
    expect(painted).not.toContain("light-dark");
    expect(painted).toContain("--dozo-glow:");
  });

  it("ignores a colour that is not a hex value", () => {
    const html = renderToString(<DozoAvatar seed="bot-7" color="red; background:url(x)" />);
    expect(html).not.toContain("red");
    expect(html).toContain("--dozo-tile:light-dark(");
  });
});

describe("DozoAvatar markup", () => {
  it.each(["working", "waiting", "idle"] as const)("applies the %s state class", (state) => {
    const html = renderToString(<DozoAvatar seed="sora" state={state} />);
    expect(html).toContain(`dozo-avatar-${state}`);
    expect(html).toContain(`data-state="${state}"`);
  });

  it("sizes the avatar inline and merges className", () => {
    const html = renderToString(<DozoAvatar seed="sora" size={72} className="extra" />);
    expect(html).toMatch(/style="[^"]*width:72px;height:72px/);
    expect(html).toContain("dozo-avatar");
    expect(html).toContain("extra");
  });

  it("is hidden from assistive tech without a title and labelled with one", () => {
    expect(renderToString(<DozoAvatar seed="sora" />)).toContain('aria-hidden="true"');
    const labelled = renderToString(<DozoAvatar seed="sora" title="Sora is working" />);
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="Sora is working"');
  });

  it("turns the idle motion off below 32 px", () => {
    expect(renderToString(<DozoAvatar seed="sora" size={28} />)).toContain('data-motion="still"');
    expect(renderToString(<DozoAvatar seed="sora" size={32} />)).toContain('data-motion="full"');
  });

  it("renders on the server without touching window, document or matchMedia", () => {
    const trap = (name: string) =>
      new Proxy(
        {},
        {
          get() {
            throw new Error(`${name} touched during server render`);
          },
        },
      );
    vi.stubGlobal("window", trap("window"));
    vi.stubGlobal("document", trap("document"));
    vi.stubGlobal("matchMedia", trap("matchMedia"));
    const html = renderToString(<DozoAvatar seed="hana" state="waiting" size={72} />);
    expect(html).toContain('data-character="hana"');
  });

  it("can be imported where window does not exist", async () => {
    vi.resetModules();
    vi.stubGlobal("window", undefined);
    const fresh = await import("./dozo-avatar.js");
    expect(fresh.DOZO_CHARACTERS).toHaveLength(6);
  });
});

describe("DozoAvatar pointer tracking", () => {
  it("shares one pointer listener across every mounted avatar and removes it on unmount", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const first = mount(<DozoAvatar seed="sora" size={72} />);
    const second = mount(<DozoAvatar seed="kumo" size={36} />);
    expect(pointerMoveAdds(add)).toBe(1);
    first.unmount();
    expect(pointerMoveAdds(remove)).toBe(0);
    second.unmount();
    expect(pointerMoveAdds(remove)).toBe(1);
  });

  it("attaches no pointer listener when interactive is false", () => {
    const add = vi.spyOn(window, "addEventListener");
    mount(<DozoAvatar seed="sora" size={72} interactive={false} />);
    expect(pointerMoveAdds(add)).toBe(0);
  });

  it("attaches no pointer listener below 32 px", () => {
    const add = vi.spyOn(window, "addEventListener");
    mount(<DozoAvatar seed="sora" size={28} />);
    expect(pointerMoveAdds(add)).toBe(0);
  });

  it("moves the eyes towards the pointer and runs no frames once unmounted", () => {
    vi.useFakeTimers();
    const { container, unmount } = mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    const eyes = container.querySelector<SVGGElement>(".da-eyes");
    expect(eyes).not.toBeNull();
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, clientY: 0 }));
      vi.advanceTimersByTime(400);
    });
    const match = eyes?.style.transform.match(/translate\(([-\d.]+)px/);
    expect(Number(match?.[1])).toBeGreaterThan(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("DozoAvatar timers", () => {
  it("keeps no timer for a small avatar, so blinking costs nothing per instance", () => {
    vi.useFakeTimers();
    const { unmount } = mount(<DozoAvatar seed="sora" size={28} />);
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it("leaves no timer or frame behind when a hovered avatar unmounts", () => {
    vi.useFakeTimers();
    const { container, unmount } = mount(<DozoAvatar seed="taro" size={72} state="idle" />);
    const root = container.querySelector(".dozo-avatar");
    act(() => {
      root?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      root?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
    });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses no raw timer in the component", () => {
    const source = readFileSync(join(import.meta.dirname, "dozo-avatar.tsx"), "utf8");
    expect(source).not.toMatch(/\bset(?:Timeout|Interval)\s*\(/);
  });
});

// jsdom exposes the Webkit-prefixed animation style property, so React listens for the prefixed name.
const ANIMATION_END = "webkitAnimationEnd";
const REDUCED = "(prefers-reduced-motion: reduce)";

type MediaListener = (event: { matches: boolean }) => void;

/** A reduced-motion media query the test can flip, with the change listeners it was given. */
function preferReducedMotion(reduce: boolean) {
  const listeners = new Set<MediaListener>();
  const query = {
    matches: reduce,
    addEventListener: (_type: string, listener: MediaListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: MediaListener) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", (text: string) => (text === REDUCED ? query : { matches: false }));
  return {
    listeners,
    set(next: boolean) {
      query.matches = next;
      act(() => {
        for (const listener of listeners) listener({ matches: next });
      });
    },
  };
}

/** Stands in for IntersectionObserver or ResizeObserver and lets a test deliver entries. */
function fakeObserver() {
  const instances: Observer[] = [];
  class Observer {
    observed = new Set<Element>();
    constructor(public callback: (entries: unknown[]) => void) {
      instances.push(this);
    }
    observe(element: Element) {
      this.observed.add(element);
    }
    unobserve(element: Element) {
      this.observed.delete(element);
    }
    disconnect() {
      this.observed.clear();
    }
  }
  return { Observer, instances };
}

function eyesOf(container: HTMLElement) {
  const eyes = container.querySelector<SVGGElement>(".da-eyes");
  if (!eyes) throw new Error("no eyes");
  return eyes;
}

function eyeState(eyes: SVGGElement) {
  const match = eyes.style.transform.match(
    /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scaleY\(([\d.]+)\)/,
  );
  if (!match) throw new Error(`unexpected transform "${eyes.style.transform}"`);
  return { x: Number(match[1]), y: Number(match[2]), open: Number(match[3]) };
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

function pointerAt(clientX: number, clientY = 0) {
  act(() => {
    window.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY }));
  });
}

function hover(container: HTMLElement, entering: boolean) {
  const root = container.querySelector(".dozo-avatar");
  act(() => {
    root?.dispatchEvent(new MouseEvent(entering ? "pointerover" : "pointerout", { bubbles: true }));
  });
}

describe("DozoAvatar characters", () => {
  it("draws a different face for each character", () => {
    const markup = DOZO_CHARACTERS.map((name) => renderToString(<DozoAvatar seed={name} />));
    const faces = markup.map((html) => html.slice(html.indexOf("<svg")));
    expect(new Set(faces).size).toBe(DOZO_CHARACTERS.length);
    for (const html of markup) expect(html).toContain('class="da-eyes"');
    expect(markup[DOZO_CHARACTERS.indexOf("yuki")]).toContain('d="M33.5 35q3.5-3.4 7 0"');
    expect(markup[DOZO_CHARACTERS.indexOf("mochi")]).toContain('transform="rotate(28 41 13)"');
  });
});

describe("DozoAvatar eye motion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each([
    ["working", 2.56],
    ["waiting", 3.2],
  ] as const)("a %s avatar follows the pointer with its own gain", (state, shift) => {
    const { container } = mount(<DozoAvatar seed="sora" size={72} state={state} />);
    pointerAt(400);
    advance(1000);
    const eyes = eyeState(eyesOf(container));
    expect(eyes.x).toBeCloseTo(shift, 1);
    expect(eyes.y).toBeCloseTo(0, 5);
    expect(eyes.open).toBe(1);
  });

  it("keeps the eyes centred while there is no pointer, and stops touching them once settled", () => {
    const { container } = mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    advance(500);
    const eyes = eyesOf(container);
    expect(eyeState(eyes)).toEqual({ x: 0, y: 0, open: 1 });
    const writes = vi.spyOn(eyes.style, "transform", "set");
    advance(500);
    expect(writes).not.toHaveBeenCalled();
  });

  it("a sleeping idle avatar barely moves and keeps its eyes half shut", () => {
    const { container } = mount(<DozoAvatar seed="sora" size={72} state="idle" />);
    pointerAt(400);
    advance(1000);
    const eyes = eyeState(eyesOf(container));
    expect(eyes.x).toBeCloseTo(0.48, 1);
    expect(eyes.open).toBeCloseTo(0.3, 2);
  });

  it("hovering wakes an idle avatar and leaving lets it fall asleep again after a pause", () => {
    const { container } = mount(<DozoAvatar seed="sora" size={72} state="idle" />);
    pointerAt(400);
    hover(container, true);
    advance(1000);
    const awake = eyeState(eyesOf(container));
    expect(awake.x).toBeCloseTo(2.56, 1);
    expect(awake.open).toBeCloseTo(1, 1);

    hover(container, false);
    advance(800);
    expect(eyeState(eyesOf(container)).open).toBeCloseTo(1, 1);
    advance(1500);
    const asleep = eyeState(eyesOf(container));
    expect(asleep.open).toBeCloseTo(0.3, 1);
    expect(asleep.x).toBeCloseTo(0.48, 1);
  });

  it("hovering again before the pause ends keeps it awake", () => {
    const { container } = mount(<DozoAvatar seed="sora" size={72} state="idle" />);
    pointerAt(400);
    hover(container, true);
    hover(container, false);
    advance(500);
    hover(container, true);
    advance(2500);
    expect(eyeState(eyesOf(container)).open).toBeCloseTo(1, 1);
  });

  it.each([
    ["the window loses focus", () => window.dispatchEvent(new Event("blur"))],
    [
      "the pointer leaves the page",
      () => document.documentElement.dispatchEvent(new Event("pointerleave")),
    ],
  ])("the eyes return to centre when %s", (_name, away) => {
    const { container } = mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    pointerAt(400);
    advance(1000);
    expect(eyeState(eyesOf(container)).x).toBeGreaterThan(3);
    act(away);
    advance(1000);
    expect(eyeState(eyesOf(container)).x).toBeCloseTo(0, 1);
  });

  it.each([
    ["resize", () => window.dispatchEvent(new Event("resize"))],
    ["scroll", () => window.dispatchEvent(new Event("scroll"))],
  ])("measures the avatar again after a %s", (_name, event) => {
    const { container } = mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    const root = container.querySelector<HTMLElement>(".dozo-avatar");
    const rect = (left: number) => () => ({ left, top: 0, width: 0, height: 0 }) as DOMRect;
    if (root) root.getBoundingClientRect = rect(0);
    advance(50);
    if (root) root.getBoundingClientRect = rect(400);
    pointerAt(400);
    act(event);
    advance(1000);
    expect(eyeState(eyesOf(container)).x).toBeCloseTo(0, 1);
  });
});

describe("DozoAvatar reduced motion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("does not track the pointer when the user prefers reduced motion", () => {
    preferReducedMotion(true);
    const { container } = mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    pointerAt(400);
    advance(1000);
    expect(eyeState(eyesOf(container))).toEqual({ x: 0, y: 0, open: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows a change of the preference while mounted, through one shared listener", () => {
    const media = preferReducedMotion(false);
    const first = mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    mount(<DozoAvatar seed="kumo" size={72} state="waiting" />);
    expect(media.listeners.size).toBe(1);

    pointerAt(400);
    advance(1000);
    expect(eyeState(eyesOf(first.container)).x).toBeGreaterThan(3);

    media.set(true);
    advance(1000);
    expect(eyeState(eyesOf(first.container)).x).toBe(0);
    pointerAt(400);
    advance(1000);
    expect(eyeState(eyesOf(first.container)).x).toBe(0);

    media.set(false);
    pointerAt(400);
    advance(1000);
    expect(eyeState(eyesOf(first.container)).x).toBeGreaterThan(3);
  });

  it("drops the shared preference listener with the last avatar", () => {
    const media = preferReducedMotion(false);
    const only = mount(<DozoAvatar seed="sora" size={72} />);
    expect(media.listeners.size).toBe(1);
    only.unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("does not hop on hover when the preference is on", () => {
    preferReducedMotion(true);
    const { container } = mount(<DozoAvatar seed="sora" size={72} />);
    hover(container, true);
    expect(container.querySelector("svg")?.classList.contains("is-hop")).toBe(false);
  });
});

describe("DozoAvatar frame loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("stops requesting frames once every eye has settled, and restarts on a pointer move", () => {
    mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    expect(vi.getTimerCount()).toBe(1);
    advance(100);
    expect(vi.getTimerCount()).toBe(0);

    pointerAt(400);
    expect(vi.getTimerCount()).toBe(1);
    advance(2000);
    expect(vi.getTimerCount()).toBe(0);
    advance(2000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes again for a scroll and a resize", () => {
    mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    advance(100);
    for (const event of ["scroll", "resize"]) {
      act(() => {
        window.dispatchEvent(new Event(event));
      });
      expect(vi.getTimerCount()).toBe(1);
      advance(100);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("does not measure while there is no pointer, and measures once when one appears", () => {
    const { container } = mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    const rect = rectSpy(container);
    advance(100);
    for (let i = 0; i < 3; i++) {
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      advance(100);
    }
    expect(rect).not.toHaveBeenCalled();

    pointerAt(400);
    advance(2000);
    expect(rect).toHaveBeenCalledTimes(1);
    pointerAt(410);
    advance(2000);
    expect(rect).toHaveBeenCalledTimes(1);
  });

  it("keeps running until a left idle avatar has fallen asleep, then stops", () => {
    const { container } = mount(<DozoAvatar seed="sora" size={72} state="idle" />);
    advance(100);
    hover(container, true);
    advance(3000);
    expect(vi.getTimerCount()).toBe(0);
    hover(container, false);
    advance(500);
    expect(vi.getTimerCount()).toBe(1);
    advance(3000);
    expect(vi.getTimerCount()).toBe(0);
    expect(eyeState(eyesOf(container)).open).toBeCloseTo(0.3, 3);
  });

  it("marks only an awake idle avatar so CSS lets it blink", () => {
    const { container } = mount(<DozoAvatar seed="sora" size={72} state="idle" />);
    const root = container.querySelector(".dozo-avatar");
    advance(100);
    expect(root?.hasAttribute("data-awake")).toBe(false);
    hover(container, true);
    advance(100);
    expect(root?.hasAttribute("data-awake")).toBe(true);
    hover(container, false);
    advance(3000);
    expect(root?.hasAttribute("data-awake")).toBe(false);
  });
});

function rectSpy(container: HTMLElement) {
  const root = container.querySelector<HTMLElement>(".dozo-avatar");
  if (!root) throw new Error("no root");
  return vi.spyOn(root, "getBoundingClientRect");
}

describe("DozoAvatar visibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("shares one observer, measures only visible avatars and pauses the others", () => {
    const io = fakeObserver();
    vi.stubGlobal("IntersectionObserver", io.Observer);
    const hidden = mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    const shown = mount(<DozoAvatar seed="kumo" size={72} state="waiting" />);
    const small = mount(<DozoAvatar seed="hana" size={28} />);
    expect(io.instances).toHaveLength(1);
    expect(io.instances[0]?.observed.size).toBe(3);

    const hiddenRoot = hidden.container.querySelector(".dozo-avatar");
    const smallRoot = small.container.querySelector(".dozo-avatar");
    act(() =>
      io.instances[0]?.callback([
        { target: hiddenRoot, isIntersecting: false },
        { target: smallRoot, isIntersecting: false },
      ]),
    );
    expect(hiddenRoot?.hasAttribute("data-offscreen")).toBe(true);
    expect(smallRoot?.hasAttribute("data-offscreen")).toBe(true);

    const hiddenRect = rectSpy(hidden.container);
    const shownRect = rectSpy(shown.container);
    pointerAt(10);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    advance(100);
    expect(hiddenRect).not.toHaveBeenCalled();
    expect(shownRect).toHaveBeenCalledTimes(1);

    act(() => io.instances[0]?.callback([{ target: hiddenRoot, isIntersecting: true }]));
    advance(100);
    expect(hiddenRoot?.hasAttribute("data-offscreen")).toBe(false);
    expect(hiddenRect).toHaveBeenCalledTimes(1);
  });

  it("lets go of the observer when the last avatar unmounts", () => {
    const io = fakeObserver();
    vi.stubGlobal("IntersectionObserver", io.Observer);
    const one = mount(<DozoAvatar seed="sora" size={72} />);
    const two = mount(<DozoAvatar seed="kumo" size={72} />);
    one.unmount();
    expect(io.instances[0]?.observed.size).toBe(1);
    two.unmount();
    expect(io.instances[0]?.observed.size).toBe(0);
  });

  it("treats every avatar as visible where IntersectionObserver is missing", () => {
    const { container } = mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    const rect = rectSpy(container);
    pointerAt(10);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    advance(100);
    expect(rect).toHaveBeenCalled();
    expect(container.querySelector(".dozo-avatar")?.hasAttribute("data-offscreen")).toBe(false);
  });

  it("keeps an off-screen avatar unmeasured when its tracker is rebuilt", () => {
    const io = fakeObserver();
    vi.stubGlobal("IntersectionObserver", io.Observer);
    const { container } = mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    const root = container.querySelector<HTMLElement>(".dozo-avatar");
    act(() => io.instances[0]?.callback([{ target: root, isIntersecting: false }]));
    const view = mount(<DozoAvatar seed="kumo" size={72} />);
    const rect = rectSpy(container);
    pointerAt(10);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    advance(100);
    expect(rect).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("DozoAvatar own size", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("measures again on the next frame after its own box changes, using one shared observer", () => {
    const ro = fakeObserver();
    vi.stubGlobal("ResizeObserver", ro.Observer);
    const first = mount(<DozoAvatar seed="sora" size={72} state="waiting" />);
    mount(<DozoAvatar seed="kumo" size={72} state="waiting" />);
    expect(ro.instances).toHaveLength(1);
    expect(ro.instances[0]?.observed.size).toBe(2);

    const rect = rectSpy(first.container);
    pointerAt(10);
    advance(100);
    expect(rect).toHaveBeenCalledTimes(1);
    act(() => ro.instances[0]?.callback([]));
    expect(rect).toHaveBeenCalledTimes(1);
    advance(20);
    expect(rect).toHaveBeenCalledTimes(2);
  });

  it("stops observing when the avatar unmounts", () => {
    const ro = fakeObserver();
    vi.stubGlobal("ResizeObserver", ro.Observer);
    const one = mount(<DozoAvatar seed="sora" size={72} />);
    expect(ro.instances[0]?.observed.size).toBe(1);
    one.unmount();
    expect(ro.instances[0]?.observed.size).toBe(0);
  });
});

describe("DozoAvatar blinking", () => {
  const cssVar = (html: string, name: string) =>
    html.match(new RegExp(`${name}:(-?[\\d.]+)s`))?.[1];
  const render = (seed: string) => renderToString(<DozoAvatar seed={seed} />);

  it("derives each avatar's blink rhythm from its seed", () => {
    expect(render("bot-1")).toBe(render("bot-1"));
    const rhythms = new Set(
      Array.from({ length: 40 }, (_, i) => {
        const html = render(`bot-${i}`);
        return `${cssVar(html, "--dozo-blink-period")}/${cssVar(html, "--dozo-blink-delay")}`;
      }),
    );
    expect(rhythms.size).toBeGreaterThan(30);
  });

  it("keeps every period between four and six seconds and the phase inside it", () => {
    for (let i = 0; i < 60; i++) {
      const html = render(`bot-${i}`);
      const period = Number(cssVar(html, "--dozo-blink-period"));
      const delay = Number(cssVar(html, "--dozo-blink-delay"));
      expect(period).toBeGreaterThanOrEqual(4);
      expect(period).toBeLessThan(6);
      expect(delay).toBeLessThanOrEqual(0);
      expect(delay).toBeGreaterThan(-period);
    }
  });
});

describe("DozoAvatar hover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("hops on hover, and clears the hop only when the svg's own animation ends", () => {
    const { container } = mount(<DozoAvatar seed="sora" size={72} />);
    const svg = container.querySelector("svg");
    hover(container, true);
    expect(svg?.classList.contains("is-hop")).toBe(true);

    act(() => {
      svg?.querySelector("rect")?.dispatchEvent(new Event(ANIMATION_END, { bubbles: true }));
    });
    expect(svg?.classList.contains("is-hop")).toBe(true);
    act(() => {
      svg?.dispatchEvent(new Event(ANIMATION_END, { bubbles: true }));
    });
    expect(svg?.classList.contains("is-hop")).toBe(false);
  });
});

describe("dozo-avatar.css", () => {
  const css = readFileSync(join(import.meta.dirname, "dozo-avatar.css"), "utf8");
  const source = readFileSync(join(import.meta.dirname, "dozo-avatar.tsx"), "utf8");
  const HEX = /#[0-9a-f]{3,8}\b/gi;

  it("holds no hex colour; the six-character identity palette lives once in the component", () => {
    expect(css.match(HEX)).toBeNull();
    const palette = source.slice(
      source.indexOf("const DOZO_BOT_PALETTE"),
      source.indexOf("// Drawings, ported"),
    );
    expect(source.match(/const DOZO_BOT_PALETTE/g)).toHaveLength(1);
    expect(palette.match(HEX)).toHaveLength(18);
    const outside = source.replace(palette, "");
    // Outside the palette only upstream's colours quoted in its comment may remain.
    expect(outside.replace(/\/\*\*[\s\S]*?\*\//g, "").match(HEX)).toBeNull();
  });

  it("takes the head and visor from semantic tokens", () => {
    expect(css).toMatch(/--dozo-body:[^;]*var\(--(?:background|foreground)\)/);
    expect(css).toMatch(/--dozo-visor:[^;]*var\(--(?:background|foreground)\)/);
  });

  it("pauses animations off-screen and removes the blink under reduced motion", () => {
    expect(css).toMatch(/\[data-offscreen\][^{]*\{\s*animation-play-state: paused/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".da-blink");
    expect(reduced).toContain("animation: none");
  });
});
