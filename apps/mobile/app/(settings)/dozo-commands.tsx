import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { DozoCommandRule } from "@rakazo/contracts";
import { commandWordsLabel, prefixRuleAllowed } from "@rakazo/core";
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

type Effect = DozoCommandRule["effect"];

/**
 * The member's command rules for each bot in this Space, as the web app lists them: what each one
 * does (allow, allow with arguments, block), the bot, and, for a rule that allows, the folder and
 * whether it is for the bot's computer. Each row's menu changes what it does or removes it.
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
  const update = useSave({
    save: (input: { id: string; effect: Effect }, send) => send("dozoCommandRules/update", input),
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(t`Could not update rule`, errorText(error, t`Try again.`)),
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
            const effect =
              update.pending && update.input?.id === rule.id ? update.input.effect : rule.effect;
            const allows = effect !== "block";
            const effects: { id: Effect; title: string }[] = [
              { id: "allow", title: t`Allow` },
              ...(prefixRuleAllowed(rule.words) || effect === "allow_prefix"
                ? [{ id: "allow_prefix" as const, title: t`Allow with arguments` }]
                : []),
              { id: "block", title: t`Block` },
            ];
            const choose = (id: string) => {
              if (id === "remove") return remove.run(rule.id);
              if (id !== effect) update.run({ id: rule.id, effect: id as Effect });
            };
            return (
              <MenuView
                key={rule.id}
                title={label}
                actions={[
                  ...effects.map((entry) => ({
                    ...entry,
                    state: entry.id === effect ? ("on" as const) : ("off" as const),
                  })),
                  { id: "remove", title: t`Remove`, attributes: { destructive: true } },
                ]}
                colorScheme={colorScheme}
                onPressAction={({ nativeEvent }) => choose(nativeEvent.event)}
              >
                <SettingsRow
                  accessible
                  accessibilityRole="button"
                  accessibilityActions={[
                    ...effects.map((entry) => ({ name: entry.id, label: entry.title })),
                    { name: "remove", label: t`Remove` },
                  ]}
                  onAccessibilityAction={({ nativeEvent }) => choose(nativeEvent.actionName)}
                  dimmed={remove.pending || update.pending}
                  title={effect === "allow_prefix" ? `${label} …` : label}
                  detail={[
                    rule.botName,
                    allows ? rule.cwd : "",
                    allows && rule.computer === "hosted" ? t`Bot computer` : "",
                  ]
                    .filter(Boolean)
                    .join(", ")}
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
