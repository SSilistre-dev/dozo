import { useLingui } from "@lingui/react/macro";
import type { DozoReplayDraftStep } from "@rakazo/contracts";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Image, ScrollView, Share, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../components/settings/settings-group";
import { errorText } from "../lib/api/user-error";
import { mobileTokens } from "../lib/appearance/appearance";
import { useSideInsets } from "../lib/layout/side-insets";
import { native, useThemedStyles } from "../lib/native/native";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

/** Every step starts kept; a screenshot starts kept unless a sign-in or payment came before it. */
function startingFrames(steps: readonly DozoReplayDraftStep[]): number[] {
  return steps.flatMap((step, index) => (step.frame !== null && !step.sensitive ? [index] : []));
}

/**
 * The owner's review of one bot reply before it becomes a public replay: every step and
 * screenshot that would show, each one theirs to leave out, then the link, which the share sheet
 * offers. The reply's live links are listed below, each revoked from here.
 */
export default function DozoReplay() {
  const { messageId = "" } = useLocalSearchParams<{ messageId?: string }>();
  const { t, i18n } = useLingui();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const read = rpcQuery("dozoReplays/preview", { messageId });
  // Read again on focus only: the app coming back must not reset what the owner is choosing.
  const preview = useScreenQuery(read, { enabled: Boolean(messageId), onForeground: false });
  const steps = preview.data?.steps;
  const [choice, setChoice] = useState<{ omit: number[]; frames: number[] } | null>(null);
  const omit = choice?.omit ?? [];
  const frames = choice?.frames ?? (steps ? startingFrames(steps) : []);
  const choose = (next: Partial<{ omit: number[]; frames: number[] }>) =>
    setChoice({ omit, frames, ...next });
  const publish = useSave({
    save: (_input: undefined, send) =>
      send("dozoReplays/publish", {
        messageId,
        omit,
        frames: frames.filter((index) => !omit.includes(index)),
      }),
    stale: [read.queryKey],
    onSaved: (made) => void Share.share({ url: made.url, message: made.url }),
  });
  const revoke = useSave({
    save: (id: string, send) => send("dozoShareLinks/revoke", { id }),
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(errorText(error, t`Try again.`)),
  });
  const kept = (steps?.length ?? 0) - omit.length;
  useScreenHeader({
    title: t`Share replay`,
    action: steps
      ? {
          label: t`Create link`,
          disabled: kept === 0,
          busy: publish.pending,
          onPress: () => publish.run(undefined),
        }
      : null,
  });
  const toggle = (list: number[], index: number, on: boolean) =>
    on ? [...list, index] : list.filter((item) => item !== index);
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {preview.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {errorText(preview.error, t`Try again.`)}
          </Text>
        ) : !steps ? (
          <ActivityIndicator color={native.secondaryLabel} />
        ) : (
          <>
            <SettingsGroup footer={t`Anyone with the link can see what stays checked.`}>
              {steps.map((step, index) => {
                const on = !omit.includes(index);
                return (
                  // The list never changes while the review is open, so a step's place is its key.
                  <SettingsSwitch
                    key={index}
                    label={step.line}
                    value={on}
                    onChange={(value) => choose({ omit: toggle(omit, index, !value) })}
                  />
                );
              })}
            </SettingsGroup>
            {steps.map((step, index) =>
              step.frame !== null && !omit.includes(index) ? (
                <SettingsGroup key={index} label={step.line}>
                  <Image
                    source={{ uri: step.frame }}
                    resizeMode="contain"
                    accessibilityIgnoresInvertColors
                    style={[styles.frame, !frames.includes(index) && styles.frameLeftOut]}
                  />
                  <SettingsSwitch
                    label={t`Screenshot`}
                    value={frames.includes(index)}
                    onChange={(value) => choose({ frames: toggle(frames, index, value) })}
                  />
                </SettingsGroup>
              ) : null,
            )}
            {publish.error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {errorText(publish.error, t`Try again.`)}
              </Text>
            ) : null}
            {preview.data?.links.length ? (
              <SettingsGroup>
                {preview.data.links.map((link) => {
                  const date = i18n.date(new Date(link.expiresAt), { dateStyle: "medium" });
                  return (
                    <SettingsRow
                      key={link.id}
                      accessibilityRole="button"
                      title={t`Expires ${date}`}
                      value={t`Revoke`}
                      disabled={revoke.pending}
                      onPress={() => revoke.run(link.id)}
                    />
                  );
                })}
              </SettingsGroup>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, paddingBottom: 40, gap: 24 },
    frame: { width: "100%", aspectRatio: 16 / 10, backgroundColor: native.fill },
    frameLeftOut: { opacity: 0.4 },
    error: { color: mobileTokens().destructive, fontSize: 13 },
  });
}
