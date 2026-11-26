import { useLingui } from "@lingui/react/macro";
import type { DozoFeedbackStatus } from "@rakazo/contracts";
import {
  DOZO_FEEDBACK_MAX_CHARS,
  DOZO_FEEDBACK_MAX_IMAGES,
  dozoFeedbackFooter,
  dozoFeedbackText,
} from "@rakazo/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
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
import { NativeActionButton } from "../../components/native/native-action-button";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../../components/settings/settings-group";
import { mobileDiagnostics, reportLine, useFeedbackStatus } from "../../lib/dozo-feedback";
import type { FeedbackImage } from "../../lib/dozo-feedback-images";
import { pickFeedbackImages } from "../../lib/dozo-feedback-images";
import { native, useThemedStyles } from "../../lib/native/native";
import { useSave } from "../../lib/query/query";
import { useScreenHeader } from "../../lib/navigation/screen-header";
import { useSideInsets } from "../../lib/layout/side-insets";
import { errorText } from "../../lib/api/user-error";

/**
 * A note, up to three pictures and, when switched on, the diagnostics. The lines added under the
 * note are shown before anything leaves: the server mails exactly those with the pictures, or,
 * without mail, the person shares the report and writes to the operator's address themselves
 * (pictures are not offered then: the share sheet carries text, and they attach files themselves).
 * Opened from a message's Report, the note starts with which message it is about.
 */
export default function DozoFeedback() {
  const { t } = useLingui();
  const status = useFeedbackStatus();
  const { threadId, messageId } = useLocalSearchParams<{ threadId?: string; messageId?: string }>();
  const report = threadId && messageId ? `${reportLine(threadId, messageId)}\n\n` : "";
  useScreenHeader({ title: report ? t`Report` : t`Send feedback` });
  return status?.mode ? <FeedbackForm status={status} initial={report} /> : null;
}

function FeedbackForm({ status, initial }: { status: DozoFeedbackStatus; initial: string }) {
  const { t } = useLingui();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [message, setMessage] = useState(initial);
  const [withDiagnostics, setWithDiagnostics] = useState(false);
  const [client] = useState(mobileDiagnostics);
  const [images, setImages] = useState<FeedbackImage[]>([]);
  const addImages = async () => {
    try {
      const picked = await pickFeedbackImages(images.length);
      setImages([...images, ...picked.images]);
      if (picked.refused) Alert.alert(t`Couldn't use that image`);
    } catch {
      Alert.alert(t`Couldn't use that image`);
    }
  };
  const diagnostics = withDiagnostics ? { ...client, ...status.server } : null;
  const send = useSave({
    save: (_input, send) =>
      send("dozoFeedback/send", {
        message,
        ...(images.length ? { images: images.map((image) => image.url) } : {}),
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
          <SettingsGroup footer={dozoFeedbackFooter(status.from, diagnostics, images.length)}>
            <SettingsSwitch
              label={t`Include diagnostics`}
              value={withDiagnostics}
              onChange={setWithDiagnostics}
            />
          </SettingsGroup>
          {status.mode === "send" ? (
            <SettingsGroup>
              {images.map((image, index) => (
                <SettingsRow
                  key={`${index}-${image.name}`}
                  title={image.name}
                  value={t`Remove`}
                  accessibilityLabel={t`Remove image`}
                  onPress={() => setImages(images.filter((_, at) => at !== index))}
                />
              ))}
              {images.length < DOZO_FEEDBACK_MAX_IMAGES ? (
                <SettingsRow
                  key="add"
                  title={t`Add image`}
                  tinted
                  onPress={() => void addImages()}
                />
              ) : null}
            </SettingsGroup>
          ) : null}
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
