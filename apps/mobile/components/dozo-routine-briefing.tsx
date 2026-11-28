import { useLingui } from "@lingui/react/macro";
import { Alert } from "react-native";
import { errorText } from "../lib/api/user-error";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { SettingsGroup } from "./settings/settings-group";
import { MenuPicker } from "./ui/menu-picker";

/**
 * In a saved routine's editor, for its owner: which of their other bots co-hosts the spoken
 * briefing of its results, or Off. Shown only while a briefing can be spoken (the owner's voice
 * connection speaks, and both bots have a voice) or one is still set. Saved at once, as it is no
 * part of the routine's draft.
 */
export function DozoRoutineBriefing({ routineId }: { routineId: string }) {
  const { t } = useLingui();
  const read = rpcQuery("dozoSpokenBriefings/get", { routineId });
  const briefing = useScreenQuery(read).data;
  const save = useSave({
    save: (coHostBotId: string | null, send) =>
      send("dozoSpokenBriefings/set", { routineId, coHostBotId }),
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(errorText(error, t`Could not save`)),
  });
  if (!briefing || (!briefing.available && briefing.coHostBotId === null)) return null;
  const value = save.pending ? (save.input ?? null) : briefing.coHostBotId;
  return (
    <SettingsGroup>
      <MenuPicker
        label={t`Spoken briefing`}
        choices={[
          { key: "", label: t`Off` },
          ...briefing.coHosts.map((bot) => ({ key: bot.id, label: bot.name })),
        ]}
        value={value ?? ""}
        disabled={save.pending}
        onChange={(key) => save.run(key || null)}
      />
    </SettingsGroup>
  );
}
