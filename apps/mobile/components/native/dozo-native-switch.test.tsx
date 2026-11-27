// @vitest-environment jsdom

import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { NativeSwitch } from "./native-switch.ios";

// Runs on the branded tree: an on switch is the primary ink, not SwiftUI's system green.

const swiftToggle = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  Appearance: {
    getColorScheme: () => "light",
    setColorScheme: () => undefined,
    addChangeListener: () => ({ remove: () => undefined }),
  },
  Platform: { OS: "ios" },
}));
vi.mock("expo-secure-store", () => ({ setItemAsync: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@expo/ui/swift-ui", () => ({
  Host: (props: { children: ReactNode }) => props.children,
  Toggle: (props: unknown) => {
    swiftToggle(props);
    return null;
  },
}));
vi.mock("@expo/ui/swift-ui/modifiers", () =>
  Object.fromEntries(
    [
      "accessibilityHint",
      "accessibilityLabel",
      "disabled",
      "labelsHidden",
      "tint",
      "toggleStyle",
    ].map((name) => [name, (value: unknown) => ({ name, value })]),
  ),
);

const props = { value: true, accessibilityLabel: "Haptics", onValueChange: () => {} };
const tints = () =>
  swiftToggle.mock.lastCall?.[0].modifiers.filter(
    (modifier: { name: string }) => modifier.name === "tint",
  );

it("tints an on switch with the primary ink", () => {
  renderToStaticMarkup(<NativeSwitch {...props} />);
  expect(tints()).toEqual([{ name: "tint", value: lightTokens.primary }]);
});

it("still takes a caller's own tint", () => {
  renderToStaticMarkup(<NativeSwitch {...props} tintColor="red" />);
  expect(tints()).toEqual([{ name: "tint", value: "red" }]);
});
