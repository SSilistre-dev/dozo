import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { ModelRoleChoice } from "@rakazo/contracts";
import {
  connectedBackupOptions,
  MAX_MODEL_BACKUPS,
  modelRoleChoiceKey,
  withConnectionName,
} from "@rakazo/contracts";
import { catalogEntryFor, connectionForModelChoice } from "@rakazo/core";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { useDozoRestNote } from "../lib/dozo-model-rests";
import { closeModelPicker, openModelPicker } from "../lib/models/model-picker-selection";
import { useMobileTokens, useResolvedAppearance } from "../lib/native/native";
import { queryClient, rpcQuery, useSave } from "../lib/query/query";
import { useRosterSignals } from "../lib/api/roster-signals";
import { useScreenQuery } from "../lib/query/screen-query";
import { errorText } from "../lib/api/user-error";
import { NativeSymbol } from "./native/native-symbol";
import { SettingsGroup, SettingsRow } from "./settings/settings-group";

/** What a row's menu offers, and what the screen reader's actions name. */
type RowAction = MenuAction & { id: string };

const choiceOf = (option: {
  provider: string;
  modelId: string;
  credentialId?: string;
}): ModelRoleChoice => ({
  provider: option.provider,
  modelId: option.modelId,
  ...(option.credentialId ? { credentialId: option.credentialId } : {}),
});

/**
 * A bot's own backup models, in order, under its model in the bot's settings, as the web shows
 * them: one "Add fallback" line until there is one. They take over from the bot's model in their
 * order; with none, the bot's runs take the runner's own backups. Picked from the models of your
 * own connections. Nothing when the server has no such setting or it cannot be read. Read again
 * on the roster signal a change sends.
 */
export function DozoBotBackups({ botId }: { botId: string }) {
  const { t } = useLingui();
  const router = useRouter();
  const restNote = useDozoRestNote();
  const me = useScreenQuery(rpcQuery("me")).data;
  const read = rpcQuery("dozoBotModelBackups/get", { botId });
  const saved = useScreenQuery(read).data?.backups;
  useRosterSignals(() => queryClient.invalidateQueries({ queryKey: read.queryKey }), true);
  const credentials = useScreenQuery(rpcQuery("models/credentials")).data ?? [];
  const catalog =
    useScreenQuery(rpcQuery("models/forRole", { role: "main", expectedUserId: me?.userId ?? "" }), {
      enabled: Boolean(me),
    }).data ?? [];
  const save = useSave({
    save: (backups: ModelRoleChoice[], send) => send("dozoBotModelBackups/set", { botId, backups }),
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(errorText(error, t`Could not save`)),
  });
  // A pick that comes back after the list moved applies to the list as it is then.
  const latest = useRef<ModelRoleChoice[]>([]);
  const picker = useRef<string | undefined>(undefined);
  useEffect(
    () => () => {
      if (picker.current) closeModelPicker(picker.current);
    },
    [],
  );
  if (!saved) return null;
  // While a save is on its way the list shows what it sends.
  const rows = save.pending && save.input ? save.input : saved;
  latest.current = rows;
  const options = connectedBackupOptions(catalog, credentials);
  const optionFor = (choice: ModelRoleChoice) =>
    options.find((option) => modelRoleChoiceKey(option) === modelRoleChoiceKey(choice));
  const modelName = (choice: ModelRoleChoice) =>
    optionFor(choice)?.label ??
    catalogEntryFor(catalog, choice.provider, choice.modelId)?.label ??
    choice.modelId;
  const detail = (choice: ModelRoleChoice) =>
    restNote(connectionForModelChoice(credentials, choice)?.id, choice.modelId) ??
    optionFor(choice)?.connectionName;
  const unused = options.filter(
    (option) => !rows.some((row) => modelRoleChoiceKey(row) === modelRoleChoiceKey(option)),
  );
  const commit = (next: ModelRoleChoice[]) => save.run(next);

  /** The searchable model list, with the models no row has; a pick comes back as `onPick`. */
  function choose(title: string, onPick: (choice: ModelRoleChoice) => void) {
    if (picker.current) closeModelPicker(picker.current);
    picker.current = openModelPicker({
      title,
      selectedKey: "",
      choices: unused.map((option) => ({
        key: modelRoleChoiceKey(option),
        label: withConnectionName(option.label, option.connectionName),
        modelLabel: option.label,
        providerLabel: option.connectionName,
        provider: option.provider,
        modelId: option.modelId,
      })),
      onSelect: (picked) => {
        const option = unused.find((entry) => modelRoleChoiceKey(entry) === picked.key);
        if (option) onPick(choiceOf(option));
      },
    });
    router.push({ pathname: "/model-picker", params: { requestId: picker.current } });
  }

  function act(index: number, id: string) {
    if (save.pending) return;
    const current = latest.current;
    if (id === "remove") {
      commit(current.filter((_, at) => at !== index));
      return;
    }
    const target = index + (id === "moveUp" ? -1 : 1);
    if (target < 0 || target >= current.length) return;
    const next = [...current];
    next.splice(target, 0, ...next.splice(index, 1));
    commit(next);
  }

  return (
    <SettingsGroup>
      {rows.map((choice, index) => {
        const name = modelName(choice);
        const actions: RowAction[] = [
          ...(index > 0 ? [{ id: "moveUp", title: t`Move up` }] : []),
          ...(index < rows.length - 1 ? [{ id: "moveDown", title: t`Move down` }] : []),
          { id: "remove", title: t`Remove`, attributes: { destructive: true } },
        ];
        return (
          <View key={modelRoleChoiceKey(choice)} style={styles.row}>
            <View style={styles.content}>
              <SettingsRow
                accessibilityRole="button"
                title={name}
                detail={detail(choice)}
                disabled={save.pending}
                onPress={() =>
                  choose(t`Change ${name}`, (picked) =>
                    commit(latest.current.map((row, at) => (at === index ? picked : row))),
                  )
                }
                accessibilityActions={actions.map(({ id, title: label }) => ({
                  name: id,
                  label,
                }))}
                onAccessibilityAction={({ nativeEvent }) => act(index, nativeEvent.actionName)}
              />
            </View>
            <RowMenu
              label={t`${name} options`}
              actions={actions}
              disabled={save.pending}
              onAction={(id) => act(index, id)}
            />
          </View>
        );
      })}
      {rows.length < MAX_MODEL_BACKUPS && unused.length ? (
        <SettingsRow
          key="add"
          title={t`Add fallback`}
          disabled={save.pending}
          onPress={() => choose(t`Add fallback`, (picked) => commit([...latest.current, picked]))}
        />
      ) : null}
    </SettingsGroup>
  );
}

function RowMenu({
  label,
  actions,
  onAction,
  disabled,
}: {
  label: string;
  actions: RowAction[];
  onAction: (id: string) => void;
  disabled: boolean;
}) {
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const button = (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={styles.buttonInner}
    >
      <NativeSymbol
        ios="ellipsis"
        android="ellipsis-horizontal"
        color={tokens.mutedForeground}
        size={20}
      />
    </View>
  );
  return disabled ? (
    <View style={styles.button}>{button}</View>
  ) : (
    <MenuView
      colorScheme={colorScheme}
      title={label}
      actions={actions}
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
      style={styles.button}
    >
      {button}
    </MenuView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  content: { flex: 1 },
  button: { borderRadius: 22, overflow: "hidden", marginEnd: 16 },
  buttonInner: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
