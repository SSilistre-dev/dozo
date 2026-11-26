import { View } from "react-native";
import { DozoInboxSeigaiha, DozoWordmark } from "./dozo-inbox-seigaiha";

/** The brand above the sign-in title: waves behind the page top and the wordmark, as on the inbox. */
export function DozoAuthMark() {
  return (
    <>
      <DozoInboxSeigaiha />
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ alignItems: "center", marginBottom: 24 }}
      >
        <DozoWordmark />
      </View>
    </>
  );
}
