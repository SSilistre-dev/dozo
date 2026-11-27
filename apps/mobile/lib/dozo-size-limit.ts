import { t } from "@lingui/core/macro";
import { Alert } from "react-native";
import { storeBuild } from "./dozo-store-build";

/**
 * Says that the plan does not include the chosen computer size. Only a build that sells plans
 * offers Upgrade; the store build names the limit and nothing else (App Review 3.1.1).
 */
export function showSizeNotInPlan(openBilling: () => void, store = storeBuild): void {
  Alert.alert(
    t`Your plan does not include this size.`,
    undefined,
    store
      ? [{ text: t`Close`, style: "cancel" }]
      : [
          { text: t`Cancel`, style: "cancel" },
          { text: t`Upgrade`, onPress: openBilling },
        ],
  );
}
