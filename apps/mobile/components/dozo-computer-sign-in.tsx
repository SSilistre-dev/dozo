import { useLingui } from "@lingui/react/macro";
import { useRouter } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAppForeground } from "../lib/app-foreground";
import { isRelayGone, relayApprovalCodeOf, subscribeRelayGone } from "../lib/dozo-relay-fetch";
import type { ComputerSignIn } from "../lib/dozo-relay-sign-in";
import { askComputerForSignIn } from "../lib/dozo-relay-sign-in";
import { useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

/**
 * Sign-in when the app's server is a paired computer. No password is asked here: a code someone
 * else showed could have paired the phone with their computer, and a password typed now would go
 * to them. The phone asks the computer for its sign-in instead, whenever this screen shows or the
 * app comes back to the front; the computer gives one while its account is signed in there, once
 * per pairing. When the computer removed this phone, or its one sign-in is used up, the way back is
 * to pair again.
 */
export function DozoComputerSignIn({ apiBase }: { apiBase: string }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const router = useRouter();
  const foreground = useAppForeground();
  const gone = useSyncExternalStore(subscribeRelayGone, () => isRelayGone(apiBase));
  const [answer, setAnswer] = useState<ComputerSignIn | null>(null);
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void relayApprovalCodeOf(apiBase).then((value) => {
      if (active) setCode(value);
    });
    return () => {
      active = false;
    };
  }, [apiBase]);

  useEffect(() => {
    if (!foreground || gone) return;
    let active = true;
    void askComputerForSignIn()
      // A failure that is not the network's (an unreadable answer, a sign-in that could not be
      // saved) still leaves the screen with something true to say.
      .catch((): ComputerSignIn => "unreachable")
      .then((result) => {
        if (!active) return;
        if (result === "signed-in") router.replace("/");
        else setAnswer(result);
      });
    return () => {
      active = false;
    };
  }, [foreground, gone, router]);

  const pairAgain = gone || answer === "used" || answer === "not-approved";
  // While the computer holds the request, the user approves there and compares this code.
  const waiting = !gone && answer === null && code !== null;
  const line = gone
    ? t`This phone was removed from your computer.`
    : waiting
      ? t`Approve this phone on your computer.`
      : answer === "not-approved"
        ? t`This phone was not approved in time.`
        : answer === "used"
          ? t`Pair again to sign in on this phone.`
          : answer === "one-account"
            ? t`Your computer has more than one account, so it cannot sign this phone in.`
            : answer === "unreachable"
              ? t`Could not reach your computer.`
              : t`Sign in on your computer to use it here.`;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 32 }}>
        <Text
          style={{ color: tokens.foreground, fontSize: 17, textAlign: "center", marginBottom: 24 }}
        >
          {line}
        </Text>
        {waiting ? (
          <Text
            accessibilityLabel={code.split("").join(" ")}
            style={{
              color: tokens.foreground,
              fontSize: 34,
              fontVariant: ["tabular-nums"],
              letterSpacing: 6,
              marginBottom: 24,
            }}
          >
            {`${code.slice(0, 3)} ${code.slice(3)}`}
          </Text>
        ) : null}
        {pairAgain ? (
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
