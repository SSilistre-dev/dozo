import { useLingui } from "@lingui/react/macro";
import type { DozoRevisionConfirmed } from "@rakazo/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance/appearance";
import {
  askAgain,
  confirmRemoval,
  revisableRead,
  takeEditDraft,
} from "../lib/dozo-message-actions";
import { native, useThemedStyles } from "../lib/native/native";
import { useSave } from "../lib/query/query";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { useSideInsets } from "../lib/layout/side-insets";
import { errorText } from "../lib/user-error";

/**
 * Edits a message of the person's in a chat with a bot and sends it again; the bot answers it
 * anew. An earlier message removes the later ones, so Send asks first. The chat shows the change
 * from its own events.
 */
export default function DozoEditMessage() {
  const { threadId = "", messageId = "" } = useLocalSearchParams<{
    threadId?: string;
    messageId?: string;
  }>();
  const { t } = useLingui();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [opened] = useState(() => takeEditDraft(messageId));
  const [draft, setDraft] = useState(opened.text);
  // Asked again after a refusal: the question replaces the refusal's text.
  const [askedAgain, setAskedAgain] = useState(false);
  const text = draft.trim();
  const edit = useSave({
    save: (change: { text: string; confirmed?: DozoRevisionConfirmed }, send) =>
      send("dozoMessages/edit", { threadId, messageId, ...change }),
    stale: [revisableRead(threadId).queryKey],
    closesScreen: true,
    onSaved: () => router.back(),
    onFailed: (error) =>
      void askAgain(t, { threadId, messageId, kind: "edit" }, error, (confirmed) => {
        setAskedAgain(false);
        edit.run({ text, confirmed });
      }).then(setAskedAgain),
  });
  const { confirmed } = opened;
  const send = () => {
    setAskedAgain(false);
    if (opened.removes === null) edit.run({ text, confirmed });
    else confirmRemoval(t, opened.removes, () => edit.run({ text, confirmed }));
  };
  useScreenHeader({
    title: t`Edit`,
    action: {
      label: t`Send`,
      disabled: !text,
      busy: edit.pending,
      onPress: send,
    },
  });
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <TextInput
          autoFocus
          accessibilityLabel={t`Edit`}
          value={draft}
          onChangeText={setDraft}
          editable={!edit.pending}
          multiline
          textAlignVertical="top"
          style={styles.editor}
        />
        {edit.error && !askedAgain ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {errorText(edit.error, t`Try again.`)}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 16, gap: 14 },
    editor: {
      minHeight: 160,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      padding: 14,
      fontSize: 15,
      lineHeight: 21,
    },
    error: { color: mobileTokens().destructive, fontSize: 13 },
  });
}
