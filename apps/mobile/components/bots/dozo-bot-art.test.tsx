// @vitest-environment jsdom

import {
  botLookWithShape,
  DOZO_AVATAR_ART,
  DOZO_CHARACTERS,
  dozoAvatarLayout,
  dozoBotColor,
  dozoCharacterForSeed,
} from "@rakazo/core";
import type { ReactNode } from "react";
import { act, createElement, useRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DozoBotArt as DozoBotArtType } from "./dozo-bot-art";
import { DozoBotArt } from "./dozo-bot-art";

const INK = "#141414";
const motion = vi.hoisted(() => ({
  reduced: false,
  props: [] as Array<() => { matrix: number[]; opacity?: number }>,
  styles: [] as Array<() => { transform: unknown[] }>,
  timings: [] as number[],
  hop: 0.2,
}));

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  Pressable: ({
    children,
    onPress,
    accessible,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessible?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "data-accessible": String(accessible) },
      children,
    ),
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    createAnimatedComponent: (component: unknown) => component,
  },
  cancelAnimation: () => undefined,
  Easing: { linear: (value: number) => value },
  ReduceMotion: { Never: "never" },
  useAnimatedProps: (sample: () => { matrix: number[] }) => {
    motion.props.push(sample);
    return sample();
  },
  useAnimatedStyle: (sample: () => { transform: unknown[] }) => {
    motion.styles.push(sample);
    return {};
  },
  useDerivedValue: (sample: () => unknown) => ({ value: sample() }),
  useReducedMotion: () => motion.reduced,
  useSharedValue: <T,>(value: T) => useRef({ value }).current,
  withTiming: (value: number, options?: { duration: number }) => {
    const duration = options?.duration ?? 0;
    motion.timings.push(duration);
    return duration < 1000 ? motion.hop : value;
  },
}));

vi.mock("react-native-svg", () => {
  const element =
    (tag: string) =>
    ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement(
        tag,
        {
          "data-d": props.d,
          "data-rx": props.rx,
          "data-ry": props.ry,
          "data-r": props.r,
          "data-fill": props.fill,
          "data-rule": props.fillRule,
          "data-stroke": props.stroke,
          "data-width": props.strokeWidth,
          "data-accessible": String(props.accessible),
        },
        children,
      );
  return {
    default: element("svg"),
    Ellipse: element("ellipse"),
    G: element("g"),
    Path: element("path"),
    Rect: element("rect"),
  };
});

vi.mock("../../lib/native/native", () => ({
  useMobileTokens: () => ({ foreground: INK }),
}));

describe("DozoBotArt", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
    motion.reduced = false;
    motion.hop = 0.2;
    motion.props.length = 0;
    motion.styles.length = 0;
    motion.timings.length = 0;
  });

  function render(props: Partial<Parameters<typeof DozoBotArtType>[0]> = {}) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <DozoBotArt
          color="#3EC5A8"
          identity="bot-1"
          size={42}
          activity="idle"
          motion="static"
          {...props}
        />,
      ),
    );
    return container;
  }

  const heads = (view: HTMLElement) =>
    Array.from(view.querySelectorAll("path"), (path) => path.dataset.d);
  const clockStarts = () => motion.timings.filter((ms) => ms >= 1000);
  const eyeScales = () =>
    motion.props.map((sample) => sample().matrix[3]).filter((scale) => scale !== 1);

  it.each(DOZO_CHARACTERS.map((name, index) => [name, index] as const))(
    "draws %s from a shape value, with that character's own head",
    (name, index) => {
      const view = render({ color: botLookWithShape("#3EC5A8", index) });
      const head = DOZO_AVATAR_ART[name].find(([part, tag]) => part === "head" && tag === "path");
      expect(heads(view)).toContain(head?.[3].d);
      const others = DOZO_CHARACTERS.filter((other) => other !== name).map(
        (other) =>
          DOZO_AVATAR_ART[other].find(([part, tag]) => part === "head" && tag === "path")?.[3].d,
      );
      expect(heads(view).filter((d) => others.includes(d))).toEqual([]);
    },
  );

  it("cuts the visor out of the head, strokes line eyes and gives the svg no accessibility node", () => {
    const view = render({ color: botLookWithShape("#3EC5A8", 5) });
    const body = view.querySelector('path[data-fill="#141414"]');
    expect(body?.getAttribute("data-rule")).toBe("evenodd");
    const line = view.querySelector('path[data-stroke="#141414"]');
    expect(line?.getAttribute("data-fill")).toBe("none");
    expect(line?.getAttribute("data-width")).toBe("2.6");
    expect(view.querySelector("svg")?.getAttribute("data-accessible")).toBe("false");
  });

  it("draws a circle as an ellipse of equal radii", () => {
    const view = render({ color: botLookWithShape("#3EC5A8", 2) });
    const eyes = [...view.querySelectorAll('ellipse[data-rx="2.9"]')];
    expect(eyes.map((eye) => eye.getAttribute("data-ry"))).toEqual(["2.9", "2.9"]);
    expect(view.querySelector("[data-r]")).toBeNull();
  });

  it("paints the accessory in the bot's colour, and a white bot's in the head's ink", () => {
    const coloured = render({ color: "#3EC5A8" });
    expect(
      coloured.querySelector(`[data-fill="${dozoBotColor("bot-1", "#3EC5A8")}"]`),
    ).not.toBeNull();
    act(() => root?.unmount());
    coloured.remove();
    const white = render({ color: "#FFFFFF", identity: undefined });
    expect(dozoBotColor("#FFFFFF", "#FFFFFF")).toBeUndefined();
    expect(white.querySelectorAll(`[data-fill="${INK}"]`).length).toBeGreaterThan(1);
    expect(
      white.querySelector("[data-fill]:not([data-fill='none']):not([data-fill='#141414'])"),
    ).toBeNull();
  });

  it("draws a bot with no identity and no colour as the character its fallback seed names", () => {
    const view = render({ color: "", identity: undefined });
    const character = dozoCharacterForSeed("bot");
    expect(DOZO_CHARACTERS).toContain(character);
    expect(view.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("holds a sleeper's eyes half shut, and starts no clock for it", () => {
    render({ activity: "idle", motion: "running" });
    expect(eyeScales()).toEqual([0.3]);
    expect(clockStarts()).toEqual([]);
  });

  it.each([
    ["working", "working"],
    ["reading", "working"],
    ["waiting", "waiting"],
    ["error", "idle"],
  ] as const)("treats %s as %s", (activity, state) => {
    render({ activity, motion: "static" });
    const asleep = eyeScales().includes(0.3);
    expect(asleep).toBe(state === "idle");
  });

  it("starts the clock for a working avatar of 32 px or more that is allowed to move", () => {
    render({ activity: "working", motion: "lazy" });
    expect(clockStarts()).toEqual([24 * 60 * 60 * 1000]);
  });

  it("lifts every part with the bob, so the eyes and the accessory stay on the head", () => {
    render({ activity: "working", motion: "lazy", color: botLookWithShape("#3EC5A8", 3) });
    const groups = dozoAvatarLayout("taro");
    const samples = motion.props.slice(-groups.length).map((sample) => sample().matrix);
    const lifts = samples.map(
      (matrix, index) =>
        (matrix[5] as number) - (groups[index]?.originY ?? 0) * (1 - (matrix[3] as number)),
    );
    expect(lifts[0]).not.toBe(0);
    for (const lift of lifts) expect(lift).toBeCloseTo(lifts[0] as number, 6);
  });

  it.each([
    ["static motion", { motion: "static" as const }],
    ["a small avatar", { size: 24 }],
    ["reduced motion", { reducedMotion: true }],
  ])("starts no clock for %s", (_, extra) => {
    const { reducedMotion, ...props } = extra as { reducedMotion?: boolean };
    motion.reduced = reducedMotion ?? false;
    render({ activity: "working", motion: "lazy", ...props });
    expect(clockStarts()).toEqual([]);
    expect(eyeScales()).toEqual([]);
  });

  it("is not wrapped in a button unless it can be poked", () => {
    expect(render().querySelector("button")).toBeNull();
  });

  it("hops when tapped: 0.25 s, up and tilted, once per tap", () => {
    const view = render({ pokeable: true, activity: "working", motion: "lazy" });
    const button = view.querySelector("button");
    expect(button?.dataset.accessible).toBe("false");
    act(() => button?.click());
    expect(motion.timings.filter((ms) => ms < 1000)).toEqual([250]);
    // 0.2 of the hop is half way to its peak: eased out, 75% of 8% of 42 px and 5 degrees.
    expect(motion.styles.at(-1)?.().transform).toEqual([
      { translateY: -0.08 * 42 * 0.75 },
      { rotate: "-3.75deg" },
    ]);
    motion.hop = 0.7;
    act(() => button?.click());
    const [lift, tilt] = (motion.styles.at(-1)?.().transform ?? []) as [
      { translateY: number },
      { rotate: string },
    ];
    expect(lift.translateY).toBeLessThan(0);
    expect(Number.parseFloat(tilt.rotate)).toBeLessThan(0);
    expect(motion.timings.filter((ms) => ms < 1000)).toEqual([250, 250]);
  });

  it("does not hop under reduced motion", () => {
    motion.reduced = true;
    const view = render({ pokeable: true });
    act(() => view.querySelector("button")?.click());
    expect(motion.timings).toEqual([]);
  });
});
