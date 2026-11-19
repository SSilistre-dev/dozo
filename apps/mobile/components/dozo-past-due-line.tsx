import { useLingui } from "@lingui/react/macro";
import { paymentPastDue } from "@rakazo/contracts";
import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { openBillingPage } from "../lib/billing";
import { useMobileTokens } from "../lib/native";
import { queryClient, rpcQuery } from "../lib/query";
import { useScreenQuery } from "../lib/screen-query";
import { NativeActionButton } from "./native-action-button";

/**
 * One line above the chats while the subscription is past due, for the member who manages
 * billing, with the way to fix it. Read when the screen gains focus and when the app comes back,
 * so it goes once the payment is through.
 */
export function DozoPastDueLine() {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [opening, setOpening] = useState(false);
  const me = useScreenQuery(rpcQuery("me")).data;
  const billing = rpcQuery("billing/status");
  const status = useScreenQuery(billing, { enabled: Boolean(me?.billingEnabled) }).data;
  if (!me?.billingEnabled || !paymentPastDue(status)) return null;
  const manage = async () => {
    setOpening(true);
    try {
      const { url } = await rpc("billing/portal", { client: "mobile" });
      queryClient.setQueryData(billing.queryKey, await openBillingPage(url));
    } catch {
      Alert.alert(t`Could not open billing`);
    } finally {
      setOpening(false);
    }
  };
  return (
    <View accessibilityRole="summary" style={[styles.line, { borderColor: tokens.border }]}>
      <Text style={[styles.text, { color: tokens.warning }]} numberOfLines={2}>
        {t`Your last payment didn't go through.`}
      </Text>
      <NativeActionButton
        label={t`Manage billing`}
        prominence="secondary"
        size="compact"
        busy={opening}
        onPress={() => void manage()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { flex: 1, fontSize: 15 },
});
