import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { commandWordsLabel } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { Alert, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { commandRulesRead } from "../../components/dozo-account-rows";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { queryClient, useSave } from "../../lib/query";
import { useScreenHeader } from "../../lib/screen-header";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/**
 * The commands the member always allows a bot to run on their own computer in this Space, each
 * with the bot and the folder it is for. Remove makes the bot ask again.
 */
export default function DozoCommands() {
  const { t } = useLingui();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const colorScheme = useResolvedAppearance();
  const read = commandRulesRead();
  const rules = useQuery(read, queryClient).data;
  const remove = useSave({
    save: (id: string, send) => send("dozoCommandRules/remove", { id }),
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(t`Could not remove rule`, errorText(error, t`Try again.`)),
  });
  useScreenHeader({ title: t`Commands` });
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <SettingsGroup>
          {rules?.map((rule) => {
            const label = commandWordsLabel(rule.words);
            return (
              <MenuView
                key={rule.id}
                title={label}
                actions={[{ id: "remove", title: t`Remove`, attributes: { destructive: true } }]}
                colorScheme={colorScheme}
                onPressAction={() => remove.run(rule.id)}
              >
                <SettingsRow
                  accessible
                  accessibilityRole="button"
                  accessibilityActions={[{ name: "remove", label: t`Remove` }]}
                  onAccessibilityAction={() => remove.run(rule.id)}
                  dimmed={remove.pending}
                  title={label}
                  detail={[rule.botName, rule.cwd].filter(Boolean).join(", ")}
                />
              </MenuView>
            );
          })}
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, paddingBottom: 40 },
  });
}
