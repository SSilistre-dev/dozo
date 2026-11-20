import { useLingui } from "@lingui/react/macro";
import { useRouter } from "expo-router";
import { useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { isRelayGone, subscribeRelayGone } from "../lib/dozo-relay-fetch";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

/**
 * Sign-in when the app's server is a paired computer. No password is asked here: a code someone
 * else showed could have paired the phone with their computer, and a password typed now would go
 * to them. The phone gets its sign-in from the computer instead. When the computer removed this
 * phone, the way back is to pair again.
 */
export function DozoComputerSignIn({ apiBase }: { apiBase: string }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const router = useRouter();
  const gone = useSyncExternalStore(subscribeRelayGone, () => isRelayGone(apiBase));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 32 }}>
        <Text
          style={{ color: tokens.foreground, fontSize: 17, textAlign: "center", marginBottom: 24 }}
        >
          {gone
            ? t`This phone was removed from your computer.`
            : t`Sign in on your computer to use it here.`}
        </Text>
        {gone ? (
          <NativeActionButton
            label={t`Pair again`}
            onPress={() => router.push("/dozo-pair")}
            prominence="primary"
          />
        ) : null}
        <NativeActionButton
          label={t`Use another server`}
          onPress={() => router.push("/server")}
          prominence="plain"
          style={{ marginTop: 16 }}
        />
      </View>
    </SafeAreaView>
  );
}
