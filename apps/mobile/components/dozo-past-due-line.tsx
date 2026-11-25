import { useLingui } from "@lingui/react/macro";
import { paymentPastDue } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import { Alert, StyleSheet, Text, View } from "react-native";
import { openBillingPage } from "../lib/billing/billing";
import { storeBuild } from "../lib/dozo-store-build";
import { useMobileTokens } from "../lib/native/native";
import { queryClient, rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { NativeActionButton } from "./native/native-action-button";

/**
 * One line above the chats while the subscription is past due, for the member who manages
 * billing, with the way to fix it. Read when the screen gains focus and when the app comes back,
 * so it goes once the payment is through. The store build sells nothing, so it shows no line.
 */
export function DozoPastDueLine() {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const me = useScreenQuery(rpcQuery("me")).data;
  const billing = rpcQuery("billing/status");
  const status = useScreenQuery(billing, {
    enabled: Boolean(me?.billingEnabled) && !storeBuild,
  }).data;
  const manage = useSave({
    save: async (_, send) => {
      const { url } = await send("billing/portal", { client: "mobile" });
      const next = await openBillingPage(url, send);
      await writeSaved(queryClient, billing.queryKey, () => next);
    },
    onFailed: () => Alert.alert(t`Could not open billing`),
  });
  if (storeBuild || !me?.billingEnabled || !paymentPastDue(status)) return null;
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
