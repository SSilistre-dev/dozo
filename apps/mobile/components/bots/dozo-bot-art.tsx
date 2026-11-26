import type { AvatarMotionMode, DozoShape, LogoAvatarActivity } from "@rakazo/core";
import {
  dozoAvatarFrame,
  dozoAvatarLayout,
  dozoBotColor,
  dozoCharacterForLook,
} from "@rakazo/core";
import type { ComponentType, ReactNode } from "react";
import { useEffect } from "react";
import { Pressable } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Ellipse, G, Path, Rect } from "react-native-svg";
import { useAvatarOnScreen } from "../../lib/bots/avatar-life";
import { useLogoAvatarClock } from "../../lib/bots/logo-avatar-clock";
import { useMobileTokens } from "../../lib/native/native";

const AnimatedG = Animated.createAnimatedComponent(G);

type Frame = ReturnType<typeof dozoAvatarFrame>;
type Shape = ComponentType<Record<string, string | number | undefined>>;

const SHAPES: Record<DozoShape[1], Shape> = {
  path: Path as unknown as Shape,
  circle: Ellipse as unknown as Shape,
  ellipse: Ellipse as unknown as Shape,
  rect: Rect as unknown as Shape,
};

/** Below this size motion is off: unreadable, and wasted frames. The same as the web drawing. */
const MIN_MOTION_SIZE = 32;
const LINE_WIDTH = 2.6;
const STILL: Frame = { headY: 0, featureScale: 1, featureOpacity: 1, eyeScaleY: 1 };
/** The web's hop: 0.25 s, at 40% it is 8% of the size up and tilted 5 degrees. */
const HOP_MS = 250;
const HOP_PEAK = 0.4;
const HOP_LIFT = 0.08;
const HOP_TILT = -5;

function stateOf(activity: LogoAvatarActivity) {
  if (activity === "waiting") return "waiting";
  return activity === "idle" || activity === "error" ? "idle" : "working";
}

/**
 * One group of the drawing, moved on the UI thread. The bob lifts the whole character, as the web's
 * moves the head group that holds every part. SVG's native host takes six-value matrices,
 * so a scale is written as the scale plus the shift that keeps the group's origin where it is.
 */
function Moving({
  part,
  originX,
  originY,
  frame,
  children,
}: {
  part: DozoShape[0];
  originX: number;
  originY: number;
  frame: { readonly value: Frame };
  children: ReactNode;
}) {
  const animatedProps = useAnimatedProps(() => {
    const now = frame.value;
    if (part === "head") return { opacity: 1, matrix: [1, 0, 0, 1, 0, now.headY] };
    if (part === "eyes") {
      return {
        opacity: 1,
        matrix: [1, 0, 0, now.eyeScaleY, 0, originY * (1 - now.eyeScaleY) + now.headY],
      };
    }
    const grow = now.featureScale;
    return {
      opacity: now.featureOpacity,
      matrix: [grow, 0, 0, grow, originX * (1 - grow), originY * (1 - grow) + now.headY],
    };
  });
  return <AnimatedG animatedProps={animatedProps}>{children}</AnimatedG>;
}

/** A Dozo character as a bot's picture, moving as the web's does (`DozoAvatar`). */
export function DozoBotArt({
  color,
  identity,
  size,
  activity,
  motion,
  pokeable = false,
}: {
  color: string;
  identity?: string;
  size: number;
  activity: LogoAvatarActivity;
  motion: AvatarMotionMode;
  pokeable?: boolean;
}) {
  const tokens = useMobileTokens();
  const seed = identity || color || "bot";
  const character = dozoCharacterForLook(seed, color);
  const accent = dozoBotColor(seed, color) ?? tokens.foreground;
  const state = stateOf(activity);
  const reduced = useReducedMotion();
  const onScreen = useAvatarOnScreen();
  const canMove =
    size >= MIN_MOTION_SIZE && motion !== "static" && state !== "idle" && onScreen && !reduced;
  const milliseconds = useLogoAvatarClock(canMove);
  // Without motion a sleeper still has its eyes half shut; any other state is the open face.
  const frame = useDerivedValue(() =>
    canMove
      ? dozoAvatarFrame(character, state, milliseconds.value / 1000, seed)
      : state === "idle"
        ? dozoAvatarFrame(character, state, 0, seed)
        : STILL,
  );
  const paint = {
    body: { fill: tokens.foreground, fillRule: "evenodd" },
    line: {
      fill: "none",
      stroke: tokens.foreground,
      strokeWidth: LINE_WIDTH,
      strokeLinecap: "round",
    },
    accent: { fill: accent },
  } as const;
  const artwork = (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessible={false}>
      {dozoAvatarLayout(character).map(({ part, shapes, originX, originY }, index) => (
        <Moving
          // The layout is fixed per character, so a group's place is its identity.
          key={index}
          part={part}
          originX={originX}
          originY={originY}
          frame={frame}
        >
          {shapes.map(([, tag, kind, attrs], at) => {
            const Tag = SHAPES[tag];
            // A circle is an ellipse of equal radii: one element fewer for the native host to know.
            const geometry =
              tag === "circle" ? { ...attrs, rx: attrs.r, ry: attrs.r, r: undefined } : attrs;
            return <Tag key={at} {...geometry} {...paint[kind]} />;
          })}
        </Moving>
      ))}
    </Svg>
  );
  return pokeable ? (
    <Hop enabled={!reduced} size={size}>
      {artwork}
    </Hop>
  ) : (
    artwork
  );
}

function easeOut(progress: number) {
  "worklet";
  return 1 - (1 - progress) * (1 - progress);
}

/** A tap makes the picture hop once, like a hover on the web. */
function Hop({ enabled, size, children }: { enabled: boolean; size: number; children: ReactNode }) {
  const progress = useSharedValue(1);
  const style = useAnimatedStyle(() => {
    const at = progress.value;
    const lift =
      at < HOP_PEAK ? easeOut(at / HOP_PEAK) : 1 - easeOut((at - HOP_PEAK) / (1 - HOP_PEAK));
    return {
      transform: [{ translateY: -HOP_LIFT * size * lift }, { rotate: `${HOP_TILT * lift}deg` }],
    };
  });
  useEffect(() => {
    if (!enabled) {
      cancelAnimation(progress);
      progress.value = 1;
    }
    return () => cancelAnimation(progress);
  }, [enabled, progress]);
  const play = () => {
    if (!enabled) return;
    progress.value = 0;
    progress.value = withTiming(1, { duration: HOP_MS, easing: Easing.linear });
  };
  return (
    <Pressable accessible={false} onPress={play}>
      <Animated.View style={style}>{children}</Animated.View>
    </Pressable>
  );
}
