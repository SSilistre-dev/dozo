import { useLingui } from "@lingui/react/macro";
import type { AuditEvent } from "@rakazo/contracts";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { dozoActivityAction, useDozoActivity } from "../../lib/dozo-activity";
import { dateLocaleForUi, useUiLocale } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { useScreenHeader } from "../../lib/screen-header";
import { useSideInsets } from "../../lib/side-insets";

/**
 * The organization's activity log, newest first, as the web app shows it: what happened, to what,
 * by whom, in which Space and when. No secret or message content is in the log.
 */
export default function DozoActivity() {
  const { t, i18n } = useLingui();
  const locale = dateLocaleForUi(useUiLocale());
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const log = useDozoActivity();
  useScreenHeader({ title: t`Activity` });
  const events = log.data?.pages.flatMap((page) => page.events) ?? [];
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const row = (event: AuditEvent) => {
    const action = dozoActivityAction(event.action);
    const outcome = { success: null, denied: t`Denied`, failure: t`Failed` }[event.outcome];
    return (
      <SettingsRow
        key={event.id}
        accessible
        title={[action ? i18n._(action) : event.action, event.targetLabel]
          .filter(Boolean)
          .join(" ")}
        detail={[event.actorLabel, event.spaceName, outcome, when.format(new Date(event.createdAt))]
          .filter(Boolean)
          .join(", ")}
      />
    );
  };
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {log.data && events.length === 0 ? (
          <Text style={styles.muted}>{t`No activity yet`}</Text>
        ) : null}
        <SettingsGroup>{events.map(row)}</SettingsGroup>
        {log.isFetchNextPageError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {t`Couldn't load more`}
          </Text>
        ) : null}
        {log.hasNextPage ? (
          <NativeActionButton
            disabled={log.isFetchingNextPage}
            fill={false}
            label={t`Load older`}
            onPress={() => void log.fetchNextPage()}
            prominence="secondary"
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 16, paddingBottom: 40 },
    muted: { color: native.secondaryLabel, fontSize: 15 },
    error: { color: mobileTokens().destructive, fontSize: 14 },
  });
}
