import { useLingui } from "@lingui/react/macro";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { botShareStatusRead } from "../components/dozo-bot-share";
import {
  SettingsFooter,
  SettingsGroup,
  SettingsRow,
  SettingsSwitch,
} from "../components/settings/settings-group";
import { errorText } from "../lib/api/user-error";
import { native, useThemedStyles } from "../lib/native/native";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

/**
 * Publishes or revokes a bot's share link. It shows exactly the text that becomes public; the
 * link opens in the browser, where a signed-in person copies it.
 */
export default function DozoBotShare() {
  const { botId = "" } = useLocalSearchParams<{ botId?: string; name?: string }>();
  const { t, i18n } = useLingui();
  const styles = useThemedStyles(createStyles);
  const [includePicture, setIncludePicture] = useState(false);
  const statusRead = botShareStatusRead(botId);
  const link = useScreenQuery(statusRead).data?.link;
  const preview = useScreenQuery(rpcQuery("dozoBotShares/preview", { botId, includePicture })).data;
  useScreenHeader({ title: t`Share link` });
  const failed = (error: Error) => Alert.alert(errorText(error, t`Could not share`));
  const publish = useSave({
    save: (fingerprint: string, send) =>
      send("dozoBotShares/publish", { botId, includePicture, fingerprint }),
    stale: [statusRead.queryKey],
    onSaved: ({ url }) => void Share.share({ url, message: url }).catch(failed),
    onFailed: failed,
  });
  const revoke = useSave({
    save: (_: undefined, send) => send("dozoBotShares/revoke", { botId }),
    stale: [statusRead.queryKey],
    onFailed: failed,
  });
  if (!preview) return null;
  const { definition } = preview;
  // Every part that is published or copied, whole: a routine's prompt runs with the copier's tools.
  const routines = definition.routines.map((routine) => [
    routine.name,
    routine.crons.join(", "),
    routine.prompt,
  ]);
  const sections = [
    { label: undefined, items: [[definition.name]] },
    { label: t`Instructions`, items: [[definition.instructions]] },
    { label: t`How other bots see it`, items: [[definition.description]] },
    { label: t`Routines`, items: routines },
  ].filter((section) => section.items.some((parts) => parts.some(Boolean)));
  const busy = publish.pending || revoke.pending;
  const date = link ? i18n.date(new Date(link.expiresAt), { dateStyle: "medium" }) : "";
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      {sections.map((section) => (
        <SettingsGroup key={section.label ?? "name"} label={section.label}>
          {section.items.map((parts, index) => (
            // Two routines may read alike; the list never reorders while shown.
            <View key={index} style={styles.text}>
              {parts.filter(Boolean).map((text, part) => (
                // Each part takes its own direction, so one cannot reorder the next.
                <Text key={part} selectable style={styles.value}>
                  {text}
                </Text>
              ))}
            </View>
          ))}
        </SettingsGroup>
      ))}
      {preview.hasPicture ? (
        <SettingsGroup>
          <SettingsSwitch
            label={t`Include picture`}
            value={includePicture}
            disabled={busy}
            onChange={setIncludePicture}
          />
        </SettingsGroup>
      ) : null}
      <SettingsFooter>{t`Anyone with the link can see this and make their own copy.`}</SettingsFooter>
      <SettingsGroup>
        <SettingsRow
          accessibilityRole="button"
          title={link ? t`Create new link` : t`Create link`}
          disabled={busy}
          onPress={() => publish.run(preview.fingerprint)}
        />
        {link ? <SettingsRow title={t`Link expires ${date}`} /> : null}
        {link ? (
          <SettingsRow
            accessibilityRole="button"
            destructive
            title={t`Revoke link`}
            disabled={busy}
            onPress={() =>
              Alert.alert(t`Revoke link?`, undefined, [
                { text: t`Cancel`, style: "cancel" },
                { text: t`Revoke`, style: "destructive", onPress: () => revoke.run(undefined) },
              ])
            }
          />
        ) : null}
      </SettingsGroup>
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    content: { padding: 20, paddingBottom: 40, gap: 16 },
    text: { paddingHorizontal: 16, paddingVertical: 12, gap: 4 },
    value: { color: native.label, fontSize: 17, writingDirection: "auto" },
  });
}
