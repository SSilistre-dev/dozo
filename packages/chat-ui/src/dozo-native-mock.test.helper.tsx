import type { ReactNode } from "react";
import { createElement } from "react";

/**
 * react-native stand-in for tests that render the chat Markdown: every component is a DOM element
 * that keeps its accessibility props, a press is a click, and the style is readable as JSON.
 */
const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style)
    ? Object.assign({}, ...style.map(flatten))
    : ((style ?? {}) as Record<string, unknown>);

function native(tag: string, props: Record<string, unknown>) {
  const { children, style, onPress, accessibilityLabel, accessibilityRole, accessibilityState } =
    props;
  return createElement(
    tag,
    {
      "aria-label": accessibilityLabel,
      role: accessibilityRole,
      "data-selected": String((accessibilityState as { selected?: boolean } | undefined)?.selected),
      "data-style": JSON.stringify(flatten(style)),
      onClick: onPress as (() => void) | undefined,
    },
    children as ReactNode,
  );
}

const View = (props: Record<string, unknown>) => native("rn-view", props);
const Text = (props: Record<string, unknown>) => native("rn-text", props);
const ScrollView = (props: Record<string, unknown>) => native("rn-scroll-view", props);
const Pressable = (props: Record<string, unknown>) => native("rn-pressable", props);
const TextInput = (props: Record<string, unknown>) => native("rn-text-input", props);
const Image = (props: Record<string, unknown>) => native("rn-image", props);
const AnimatedView = (props: Record<string, unknown>) => native("rn-animated-view", props);

export function nativeMock() {
  return {
    View,
    Text,
    ScrollView,
    Pressable,
    TextInput,
    Image,
    Animated: {
      View: AnimatedView,
      createAnimatedComponent: (item: unknown) => item,
      timing: () => ({ start: () => undefined }),
      sequence: (...animations: unknown[]) => animations,
      loop: () => ({ start: () => undefined, stop: () => undefined }),
      delay: () => ({}),
      Value: class {},
    },
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten,
      hairlineWidth: 1,
      absoluteFillObject: {},
      absoluteFill: {},
    },
    Platform: {
      OS: "ios",
      select: (options: Record<string, unknown>) =>
        options.ios ?? options.default ?? options.android,
    },
    Linking: { canOpenURL: async () => true, openURL: async () => undefined },
    Alert: { alert: () => undefined },
    I18nManager: { isRTL: false },
    Dimensions: { get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }) },
    PixelRatio: { get: () => 3, roundToNearestPixel: (value: number) => value },
    useColorScheme: () => "dark",
    useWindowDimensions: () => ({ fontScale: 1 }),
  };
}
