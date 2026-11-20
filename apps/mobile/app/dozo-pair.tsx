import { useLingui } from "@lingui/react/macro";
import type { RelayPairingOffer } from "@rakazo/contracts";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { currentApiBase, flushPendingSignOut } from "../lib/api";
import { saveApiBase } from "../lib/api-server";
import { linkedOffer } from "../lib/dozo-pair-link";
import type { RelayPairingError } from "../lib/dozo-relay-connection";
import { pairRelay, readPairingOffer } from "../lib/dozo-relay-connection";
import { displayApiHost } from "../lib/dozo-relay-endpoint";
import {
  adoptRelayConnection,
  DEFAULT_RELAY,
  forgetRelayConnection,
  keepOnlyRelayConnection,
  relayDeps,
  relayPairingStore,
} from "../lib/dozo-relay-fetch";
import { useMobileTokens } from "../lib/native";
import { useScreenHeader } from "../lib/screen-header";
import { loadSessionToken } from "../lib/session";
import { useSideInsets } from "../lib/side-insets";
import { confirmUnsentSendLoss } from "../lib/unsent-send-warning";

/** Links already acted on: each arrives once, so a later visit never brings an old one back. */
const usedLinks = new Set<string>();

const hostOf = (address: string) => new URL(address).host;

/**
 * Pairs the phone with the user's own computer. The computer shows a QR code holding a link
 * (`dozo/relay/PROTOCOL.md`, Pairing link); the phone's camera opens it here. The code can also be
 * pasted. Either way the offer is checked first, then the user agrees once to what it does: which
 * relay it goes through when that is not this build's own, and which server it signs them out of.
 * Once paired, the computer is the app's server.
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

  const failure = (kind: RelayPairingError["kind"] | undefined) =>
    kind === "invalid"
      ? t`That is not a pairing code.`
      : kind === "expired"
        ? t`This code has expired. Show a new one on your computer.`
        : kind === "used"
          ? t`This code was already used. Show a new one on your computer.`
          : t`Could not reach your computer.`;

  async function agrees(offer: RelayPairingOffer) {
    const lines: string[] = [];
    if (hostOf(offer.relay) !== hostOf(DEFAULT_RELAY)) {
      lines.push(t`Uses the relay at ${hostOf(offer.relay)}.`);
    }
    if (await loadSessionToken()) {
      lines.push(t`You will be signed out of ${displayApiHost(currentApiBase())}.`);
    }
    lines.push(t`Only connect to a computer you own.`);
    return new Promise<boolean>((resolve) =>
      Alert.alert(
        t`Connect to this computer?`,
        lines.join("\n"),
        [
          { text: t`Cancel`, style: "cancel", onPress: () => resolve(false) },
          { text: t`Connect`, onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      ),
    );
  }

  async function connect(input: string) {
    if (running.current) return;
    running.current = true;
    setError(null);
    try {
      let offer: RelayPairingOffer;
      try {
        offer = readPairingOffer(input, Date.now());
      } catch (caught) {
        setError(failure((caught as RelayPairingError).kind));
        return;
      }
      if (!(await agrees(offer))) return;
      // Asked before pairing: a computer that pairs is the app's server right after.
      if (!(await confirmUnsentSendLoss("server-switch"))) return;
      setPending(true);
      const { connection, pairing } = await pairRelay(offer, relayDeps);
      adoptRelayConnection(connection);
      const saved = await saveApiBase(connection.origin);
      if (!saved.ok) {
        // The app stays on its server and the stored pairing stays the one it uses.
        forgetRelayConnection(connection.origin);
        setError(saved.error);
        return;
      }
      await relayPairingStore.save(pairing);
      // The switch signs out of the server it left; a computer paired before is reached only
      // through its own connection, so that sign-out goes before the connection closes.
      await flushPendingSignOut(true);
      keepOnlyRelayConnection(connection.origin);
      router.replace("/");
    } catch (caught) {
      setError(failure((caught as RelayPairingError).kind));
    } finally {
      running.current = false;
      setPending(false);
    }
  }

  useEffect(() => {
    const offer = linkedOffer(link);
    if (!link || !offer || usedLinks.has(link)) return;
    usedLinks.add(link);
    void connect(offer);
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
