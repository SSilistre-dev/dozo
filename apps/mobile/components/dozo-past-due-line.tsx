import { useLingui } from "@lingui/react/macro";
import { paymentPastDue } from "@rakazo/contracts";
import { Alert, StyleSheet, Text, View } from "react-native";
import { openBillingPage } from "../lib/billing";
import { useMobileTokens } from "../lib/native";
import { queryClient, rpcQuery, useSave } from "../lib/query";
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
  const me = useScreenQuery(rpcQuery("me")).data;
  const billing = rpcQuery("billing/status");
  const status = useScreenQuery(billing, { enabled: Boolean(me?.billingEnabled) }).data;
  const manage = useSave({
    save: async (_, send) => {
      const { url } = await send("billing/portal", { client: "mobile" });
      queryClient.setQueryData(billing.queryKey, await openBillingPage(url));
    },
    onFailed: () => Alert.alert(t`Could not open billing`),
  });
  if (!me?.billingEnabled || !paymentPastDue(status)) return null;
  return (
    <View accessibilityRole="summary" style={[styles.line, { borderColor: tokens.border }]}>
      <Text style={[styles.text, { color: tokens.warning }]} numberOfLines={2}>
        {t`Your last payment didn't go through.`}
      </Text>
      <NativeActionButton
        label={t`Manage billing`}
        prominence="secondary"
        size="compact"
        busy={manage.pending}
        onPress={() => manage.run()}
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
