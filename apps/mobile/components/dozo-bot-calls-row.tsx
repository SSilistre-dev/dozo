import { useLingui } from "@lingui/react/macro";
import { Alert } from "react-native";
import { errorText } from "../lib/api/user-error";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { SettingsGroup, SettingsSwitch } from "./settings/settings-group";

/**
 * Whether the bot may ring you from a routine, in its settings. Off by default; nothing shows
 * where calls are not available (the server has them off, no voice is connected, or the bot is
 * not yours).
 */
export function DozoBotCallsRow({ botId }: { botId: string }) {
  const { t } = useLingui();
  const read = rpcQuery("dozoBotCalls/get", { botId });
  const calls = useScreenQuery(read).data;
  const save = useSave({
    save: (allowed: boolean, send) => send("dozoBotCalls/set", { botId, allowed }),
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(errorText(error, t`Could not save`)),
  });
  if (!calls?.available) return null;
  return (
    <SettingsGroup>
      <SettingsSwitch
        label={t`Can call me`}
        value={save.pending ? Boolean(save.input) : calls.allowed}
        disabled={save.pending}
        onChange={(allowed) => save.run(allowed)}
      />
    </SettingsGroup>
  );
}
