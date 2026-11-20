import { useLingui } from "@lingui/react/macro";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { saveApiBase } from "../lib/api-server";
import type { RelayPairingError } from "../lib/dozo-relay-connection";
import { offerText, pairRelay } from "../lib/dozo-relay-connection";
import {
  adoptRelayConnection,
  keepOnlyRelayConnection,
  relayDeps,
  relayPairingStore,
} from "../lib/dozo-relay-fetch";
import { useMobileTokens } from "../lib/native";
import { useScreenHeader } from "../lib/screen-header";
import { useSideInsets } from "../lib/side-insets";
import { confirmUnsentSendLoss } from "../lib/unsent-send-warning";

/** Offers this process already asked about: a link opens the app once, not on every visit. */
const askedOffers = new Set<string>();

/**
 * Pairs the phone with the user's own computer. The computer shows a QR code holding a link
 * (`dozo/relay/PROTOCOL.md`, Pairing link); the phone's camera opens it here, and the user agrees
 * once before anything is sent, so no other app or page can pair the phone silently. The code can
 * also be pasted. Once paired, the computer is the app's server.
 */
export default function DozoPairScreen() {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const sideInsets = useSideInsets();
  const router = useRouter();
  const link = Linking.useLinkingURL();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const running = useRef(false);

  const failure = (kind: RelayPairingError["kind"]) =>
    ({
      invalid: t`That is not a pairing code.`,
      expired: t`This code has expired. Show a new one on your computer.`,
      used: t`This code was already used. Show a new one on your computer.`,
      unreachable: t`Could not reach your computer.`,
      "not-dozo": t`Could not reach your computer.`,
    })[kind];

  async function connect(input: string) {
    if (running.current) return;
    running.current = true;
    try {
      // Asked before pairing: a computer that pairs is the app's server right after.
      if (!(await confirmUnsentSendLoss("server-switch"))) return;
      setPending(true);
      setError(null);
      const { connection, pairing } = await pairRelay(input, relayDeps);
      adoptRelayConnection(connection);
      await relayPairingStore.save(pairing);
      const saved = await saveApiBase(connection.origin);
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      keepOnlyRelayConnection(connection.origin);
      router.replace("/");
    } catch (caught) {
      const kind = (caught as RelayPairingError).kind;
      setError(kind ? failure(kind) : t`Could not reach your computer.`);
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  useEffect(() => {
    if (!link?.includes("#")) return;
    const offer = offerText(link);
    if (askedOffers.has(offer)) return;
    askedOffers.add(offer);
    Alert.alert(t`Connect to this computer?`, t`Only connect to a computer you own.`, [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Connect`, onPress: () => void connect(offer) },
    ]);
  });

  useScreenHeader({
    title: t`Your computer`,
    action: {
      label: pending ? t`Connecting…` : t`Connect`,
      onPress: () => void connect(draft),
      disabled: !draft.trim(),
      busy: pending,
    },
  });

  return (
    <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView
        style={sideInsets}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 12, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <TextInput
          testID="pairing-code"
          accessibilityLabel={t`Pairing code`}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          editable={!pending}
          onChangeText={(value) => {
            setDraft(value);
            setError(null);
          }}
          onSubmitEditing={() => void connect(draft)}
          placeholder={t`Pairing code`}
          placeholderTextColor={tokens.mutedForeground}
          returnKeyType="go"
          style={{
            backgroundColor: tokens.muted,
            borderRadius: 13,
            padding: 16,
            color: tokens.foreground,
            fontSize: 16,
          }}
          value={draft}
        />
        {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}
