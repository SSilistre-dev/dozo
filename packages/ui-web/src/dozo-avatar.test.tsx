// @vitest-environment jsdom
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

  it("uses the character's own tile colour unless an explicit colour is given", () => {
    const html = renderToString(<DozoAvatar seed="kumo" />);
    expect(html).toContain('data-character="kumo"');
    expect(html).not.toContain("--dozo-tile");
  });

  it("respects an explicit colour and keeps the seed-based character", () => {
    const plain = renderToString(<DozoAvatar seed="bot-7" />);
    const painted = renderToString(<DozoAvatar seed="bot-7" color="#ff00aa" />);
    const character = dozoCharacterForSeed("bot-7");
    expect(plain).toContain(`data-character="${character}"`);
    expect(painted).toContain(`data-character="${character}"`);
    expect(painted).toContain("--dozo-tile:#ff00aa");
  });

  it("ignores a colour that is not a hex value", () => {
    const html = renderToString(<DozoAvatar seed="bot-7" color="red; background:url(x)" />);
    expect(html).not.toContain("--dozo-tile");
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
  it("blinks on its own and clears every timer on unmount", () => {
    vi.useFakeTimers();
    const { container, unmount } = mount(<DozoAvatar seed="sora" size={28} />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const blink = container.querySelector(".da-blink");
    let blinked = false;
    for (let t = 0; t < 7000 && !blinked; t += 50) {
      act(() => vi.advanceTimersByTime(50));
      blinked = blink?.classList.contains("is-blinking") ?? false;
    }
    expect(blinked).toBe(true);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the wake-up timer when a hovered avatar unmounts", () => {
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
});
