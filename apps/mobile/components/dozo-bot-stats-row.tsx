import { useLingui } from "@lingui/react/macro";
import { DOZO_SHARE_LINK_MAX_DAYS, DOZO_STATS_SHARE_KIND } from "@rakazo/contracts";
import { Alert, Share } from "react-native";
import { errorText } from "../lib/api/user-error";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { SettingsGroup, SettingsRow } from "./settings/settings-group";

/**
 * What the bot has done in four numbers, with a row that shares them as a card (the system share
 * sheet gets the link, which is shown once) or stops sharing. Only the bot's owner reads them:
 * for anyone else the read is refused and nothing shows.
 */
export function DozoBotStatsRow({ botId }: { botId: string }) {
  const { t } = useLingui();
  const read = useScreenQuery(rpcQuery("dozoBotStats/get", { botId })).data;
  // Upstream's screen tests answer a procedure they do not know with an empty list.
  const stats = typeof read?.tasksFinished === "number" ? read : undefined;
  const linksRead = rpcQuery("dozoShareLinks/list");
  const links = useScreenQuery(linksRead, { enabled: Boolean(stats) }).data?.links;
  const live = links?.filter(
    (link) => link.kind === DOZO_STATS_SHARE_KIND && link.targetId === botId,
  );
  const share = useSave({
    save: (_input: undefined, send) =>
      send("dozoShareLinks/create", {
        kind: DOZO_STATS_SHARE_KIND,
        targetId: botId,
        days: DOZO_SHARE_LINK_MAX_DAYS,
      }),
    stale: [linksRead.queryKey],
    onSaved: ({ url }) => {
      void Share.share({ url });
    },
    onFailed: (error) => Alert.alert(errorText(error, t`Could not share`)),
  });
  const stop = useSave({
    save: (ids: string[], send) =>
      Promise.all(ids.map((id) => send("dozoShareLinks/revoke", { id }))),
    stale: [linksRead.queryKey],
    onFailed: (error) => Alert.alert(errorText(error, t`Could not save`)),
  });
  if (!stats) return null;
  return (
    <SettingsGroup>
      <SettingsRow title={t`Tasks`} value={stats.tasksFinished.toLocaleString()} />
      <SettingsRow title={t`Routine runs`} value={stats.routineRuns.toLocaleString()} />
      <SettingsRow title={t`Skills`} value={stats.skillsLearned.toLocaleString()} />
      <SettingsRow title={t`Days active`} value={stats.daysActive.toLocaleString()} />
      {live?.length ? (
        <SettingsRow
          accessibilityRole="button"
          title={t`Stop sharing`}
          disabled={stop.pending}
          onPress={() => stop.run(live.map((link) => link.id))}
        />
      ) : (
        <SettingsRow
          accessibilityRole="button"
          title={t`Share card`}
          disabled={share.pending || links === undefined}
          onPress={() => share.run(undefined)}
        />
      )}
    </SettingsGroup>
  );
}
