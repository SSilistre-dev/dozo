import { DOZO_SEIGAIHA } from "@rakazo/core";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Defs, G, LinearGradient, Mask, Pattern, Rect, Stop } from "react-native-svg";
import { translucentColor } from "../lib/appearance/color";
import { useMobileTokens } from "../lib/native/native";

const INK_OPACITY = 0.15;
const SEAL_SIZE = 9;
const WORDMARK_INDENT = 19;

/**
 * Concentric-wave scales behind the inbox header, strongest at the top and gone by the chat list,
 * as in the web sidebar. Each scale is filled with the page colour so a later one covers the
 * earlier ones: a mask inside a pattern does not render on iOS.
 */
export function DozoInboxSeigaiha() {
  const tokens = useMobileTokens();
  const { top } = useSafeAreaInsets();
  const { tile, radii, centers, strokeWidth, fadeHeight, solidUntil } = DOZO_SEIGAIHA;
  const height = top + fadeHeight;
  const ink = translucentColor(tokens.foreground, INK_OPACITY);
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.pattern, { height }]}
    >
      <Svg width="100%" height={height}>
        <Defs>
          <Pattern
            id="dozo-seigaiha"
            width={tile.width}
            height={tile.height}
            patternUnits="userSpaceOnUse"
          >
            {centers.map(([x, y]) => (
              <G key={`${x}:${y}`} fill={tokens.background} stroke={ink} strokeWidth={strokeWidth}>
                {radii.map((r) => (
                  <Circle key={r} cx={x} cy={y} r={r} />
                ))}
              </G>
            ))}
          </Pattern>
          <LinearGradient id="dozo-seigaiha-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset={0} stopColor="white" stopOpacity={1} />
            <Stop offset={solidUntil} stopColor="white" stopOpacity={1} />
            <Stop offset={1} stopColor="white" stopOpacity={0} />
          </LinearGradient>
          <Mask id="dozo-seigaiha-mask" x="0" y="0" width="100%" height={height}>
            <Rect width="100%" height={height} fill="url(#dozo-seigaiha-fade)" />
          </Mask>
        </Defs>
        <Rect
          width="100%"
          height={height}
          fill="url(#dozo-seigaiha)"
          mask="url(#dozo-seigaiha-mask)"
        />
      </Svg>
    </View>
  );
}

/** The seal dot and "dozo", the same wordmark as the web sidebar's header. */
export function DozoWordmark() {
  const tokens = useMobileTokens();
  return (
    <View style={styles.wordmark}>
      <View style={[styles.seal, { backgroundColor: tokens.destructiveFill }]} />
      <Text accessibilityRole="header" style={[styles.name, { color: tokens.foreground }]}>
        dozo
      </Text>
    </View>
  );
}

/** The wordmark as the native header's leading item, without the glass the bar gives its items. */
export const dozoWordmarkItems = () => [
  { type: "custom" as const, element: <DozoWordmark />, hidesSharedBackground: true },
];

const styles = StyleSheet.create({
  pattern: { position: "absolute", top: 0, left: 0, right: 0 },
  wordmark: { height: 24, justifyContent: "center" },
  seal: {
    position: "absolute",
    left: 0,
    width: SEAL_SIZE,
    height: SEAL_SIZE,
    borderRadius: SEAL_SIZE / 2,
  },
  name: {
    paddingLeft: WORDMARK_INDENT,
    fontSize: 17,
    fontWeight: "500",
    letterSpacing: 0.68,
    lineHeight: 24,
  },
});
