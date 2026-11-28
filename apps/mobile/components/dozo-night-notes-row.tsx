import { useLingui } from "@lingui/react/macro";
import { dozoNightNotesChange, findDozoNightNotes } from "@rakazo/contracts";
import { Alert } from "react-native";
import { errorText } from "../lib/api/user-error";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { deviceTimeZone } from "../lib/routines/routine";
import { SettingsGroup, SettingsSwitch } from "./settings/settings-group";

/**
 * The bot's nightly memory note, as the web shows it: one switch that creates or turns on the daily
 * routine on this bot, or turns it off, in the zone the person's account uses. The routine is an
 * ordinary one and quiet hours hold its run.
 */
export function DozoNightNotesRow({ botId }: { botId: string }) {
  const { t } = useLingui();
  const read = rpcQuery("routines/list", { botId });
  const routines = useScreenQuery(read).data;
  const me = useScreenQuery(rpcQuery("me")).data;
  const save = useSave({
    save: async (on: boolean, send) => {
      const change = dozoNightNotesChange(
        await send("routines/list", { botId }),
        botId,
        me?.timezone ?? deviceTimeZone() ?? "UTC",
        on,
      );
      if (change && "create" in change) await send("routines/create", change.create);
      else if (change) await send("routines/update", change.update);
    },
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(errorText(error, t`Could not save`)),
  });
  if (!routines) return null;
  const on =
    save.pending && save.input !== undefined
      ? save.input
      : Boolean(findDozoNightNotes(routines)?.active);
  return (
    <SettingsGroup>
      <SettingsSwitch
        label={t`Nightly memory note`}
        value={on}
        disabled={save.pending}
        onChange={save.run}
      />
    </SettingsGroup>
  );
}
