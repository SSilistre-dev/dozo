import { useLingui } from "@lingui/react/macro";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Linking, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SettingsGroup, SettingsSwitch } from "../../components/settings-group";
import { phoneDevice } from "../../lib/dozo-phone-device";
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
  // The tapped value while it is being switched, so the switch does not jump back meanwhile.
  const [switching, setSwitching] = useState<boolean | null>(null);
  useScreenHeader({ title: t`Phone` });

  useEffect(() => {
    void device.sync();
  }, [device]);

  // The switch is disabled while one runs; a second tap before that lands queues behind the first.
  function switchCalendar(on: boolean) {
    setSwitching(on);
    device
      .setCalendar(on)
      .then(
        (result) => {
          if (result !== "denied") return;
          Alert.alert(t`Allow calendar access in Settings.`, undefined, [
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
        <SettingsGroup footer={t`Events a bot reads are sent to its AI model.`}>
          <SettingsSwitch
            label={t`Calendar`}
            disabled={!settings.ready || switching !== null}
            value={switching ?? settings.calendar}
            onChange={switchCalendar}
          />
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
