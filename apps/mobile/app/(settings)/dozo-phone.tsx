import { useLingui } from "@lingui/react/macro";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Linking, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SettingsGroup, SettingsSwitch } from "../../components/settings-group";
import { contactsAvailable } from "../../lib/dozo-phone-contacts";
import type { PhoneKind } from "../../lib/dozo-phone-device";
import { phoneDevice } from "../../lib/dozo-phone-device";
import { locationAvailable } from "../../lib/dozo-phone-location";
import { native, useThemedStyles } from "../../lib/native";
import { useScreenHeader } from "../../lib/screen-header";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/**
 * What bots may read from this phone. Each kind is off until switched on here, and is kept on this
 * phone only: the server sees only what the phone declares while it is connected. The pairing it
 * makes is a device endpoint, not an rpc, so the switch is saved by the device module, not `useSave`.
 */
export default function DozoPhone() {
  const { t } = useLingui();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const device = phoneDevice();
  const settings = useSyncExternalStore(device.subscribe, device.settings, device.settings);
  // The tapped switch and value while it is being switched, so it does not jump back meanwhile.
  const [switching, setSwitching] = useState<{ kind: PhoneKind; on: boolean } | null>(null);
  useScreenHeader({ title: t`Phone` });
  // Calendar's module is there whenever this page is (the Phone row checks it); a build without
  // the contacts or location module hides that switch.
  const kinds: Array<{ kind: PhoneKind; label: string; denied: string }> = [
    { kind: "calendar", label: t`Calendar`, denied: t`Allow calendar access in Settings.` },
    ...(contactsAvailable()
      ? [
          {
            kind: "contacts" as const,
            label: t`Contacts`,
            denied: t`Allow contacts access in Settings.`,
          },
        ]
      : []),
    ...(locationAvailable()
      ? [
          {
            kind: "location" as const,
            label: t`Location`,
            denied: t`Allow location access in Settings.`,
          },
        ]
      : []),
  ];

  useEffect(() => {
    void device.sync();
  }, [device]);

  // Every switch is disabled while one runs; a second tap before that lands queues behind it.
  function switchKind(kind: PhoneKind, denied: string, on: boolean) {
    setSwitching({ kind, on });
    device
      .setSwitch(kind, on)
      .then(
        (result) => {
          if (result !== "denied") return;
          Alert.alert(denied, undefined, [
            { text: t`Cancel`, style: "cancel" },
            { text: t`Settings`, onPress: () => void Linking.openSettings() },
          ]);
        },
        (error: unknown) => Alert.alert(errorText(error, t`Something went wrong. Try again.`)),
      )
      .finally(() => setSwitching(null));
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <SettingsGroup footer={t`What a bot reads is sent to its AI model.`}>
          {kinds.map(({ kind, label, denied }) => (
            <SettingsSwitch
              key={kind}
              label={label}
              disabled={!settings.ready || switching !== null}
              value={switching?.kind === kind ? switching.on : settings[kind]}
              onChange={(on) => switchKind(kind, denied, on)}
            />
          ))}
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 16, paddingBottom: 40 },
  });
}
