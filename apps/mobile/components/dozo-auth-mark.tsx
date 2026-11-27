import type { ReactNode } from "react";
import { View } from "react-native";
import { useMobileTokens } from "../lib/native/native";
import { DozoInboxSeigaiha, DozoWordmark } from "./dozo-inbox-seigaiha";

/** The sign-in screen's page: waves pinned to the very top behind the safe area and the form, as on the inbox. */
export function DozoAuthBackdrop({ children }: { children: ReactNode }) {
  const tokens = useMobileTokens();
  return (
    <View style={{ flex: 1, backgroundColor: tokens.background }}>
      <DozoInboxSeigaiha />
      {children}
    </View>
  );
}

/** The wordmark above the sign-in title. */
export function DozoAuthMark() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ alignItems: "center", marginBottom: 24 }}
    >
      <DozoWordmark />
    </View>
  );
}

/**
 * A 44pt touch target that centres its control. The native button's host fills any height it is
 * given and draws the glyph at the top, so the height belongs here, not on the button.
 */
export function DozoPasswordToggleSlot({ children }: { children: ReactNode }) {
  return (
    <View style={{ width: 44, height: 44, marginRight: 4, alignItems: "center", justifyContent: "center" }}>
      {children}
    </View>
  );
}
