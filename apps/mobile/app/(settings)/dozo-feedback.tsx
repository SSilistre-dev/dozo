import { useLingui } from "@lingui/react/macro";
import type { DozoFeedbackStatus } from "@rakazo/contracts";
import { DOZO_FEEDBACK_MAX_CHARS, dozoFeedbackFooter, dozoFeedbackText } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../../components/settings-group";
import { mobileDiagnostics, useFeedbackStatus } from "../../lib/dozo-feedback";
import { native, useThemedStyles } from "../../lib/native";
import { useSave } from "../../lib/query";
import { useScreenHeader } from "../../lib/screen-header";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/**
 * A note and, when switched on, the diagnostics. The lines added under the note are shown before
 * anything leaves: the server mails exactly those, or, without mail, the person shares the report
 * and writes to the operator's address themselves.
 */
export default function DozoFeedback() {
  const { t } = useLingui();
  const status = useFeedbackStatus();
  useScreenHeader({ title: t`Send feedback` });
  return status?.mode ? <FeedbackForm status={status} /> : null;
}

function FeedbackForm({ status }: { status: DozoFeedbackStatus }) {
  const { t } = useLingui();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [message, setMessage] = useState("");
  const [withDiagnostics, setWithDiagnostics] = useState(false);
  const [client] = useState(mobileDiagnostics);
  const diagnostics = withDiagnostics ? { ...client, ...status.server } : null;
  const send = useSave({
    save: (_input, send) =>
      send("dozoFeedback/send", {
        message,
        ...(withDiagnostics
          ? { diagnostics: { client, runIds: status.server.failedRuns.map((run) => run.id) } }
          : {}),
      }),
    onSaved: () => {
      Alert.alert(t`Sent`);
      router.back();
    },
    onFailed: (error) => Alert.alert(t`Could not send`, errorText(error, t`Try again.`)),
    closesScreen: true,
  });
  const empty = !message.trim();
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.screen}
      >
        <ScrollView
          style={sideInsets}
          contentContainerStyle={styles.content}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
        >
          <TextInput
            accessibilityLabel={t`Feedback`}
            editable={!send.pending}
            maxLength={DOZO_FEEDBACK_MAX_CHARS}
            multiline
            onChangeText={setMessage}
            placeholder={t`What happened?`}
            placeholderTextColor={native.tertiaryLabel}
            style={styles.input}
            value={message}
          />
          <SettingsGroup footer={dozoFeedbackFooter(status.from, diagnostics)}>
            <SettingsSwitch
              label={t`Include diagnostics`}
              value={withDiagnostics}
              onChange={setWithDiagnostics}
            />
          </SettingsGroup>
          {status.mode === "send" ? (
            <NativeActionButton
              busy={send.pending}
              disabled={empty}
              label={t`Send`}
              onPress={() => send.run()}
            />
          ) : (
            <>
              {status.address ? (
                <SettingsGroup>
                  <SettingsRow title={status.address} />
                </SettingsGroup>
              ) : null}
              <NativeActionButton
                disabled={empty}
                label={t`Save`}
                onPress={() =>
                  void Share.share({ message: dozoFeedbackText(message, status.from, diagnostics) })
                }
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 16, paddingBottom: 40 },
    input: {
      minHeight: 120,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
      textAlignVertical: "top",
    },
  });
}
