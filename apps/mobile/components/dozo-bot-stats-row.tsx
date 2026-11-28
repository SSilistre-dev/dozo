import { useLingui } from "@lingui/react/macro";
import { DOZO_SHARE_LINK_MAX_DAYS, DOZO_STATS_SHARE_KIND, formatDozoStat } from "@rakazo/contracts";
import { Alert, Share } from "react-native";
import { errorText } from "../lib/api/user-error";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { SettingsGroup, SettingsRow } from "./settings/settings-group";
import { LoadFailure } from "./ui/load-failure";

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
  const linksQuery = useScreenQuery(linksRead, { enabled: Boolean(stats) });
  const links = linksQuery.data?.links;
  const live = links?.filter(
    (link) => link.kind === DOZO_STATS_SHARE_KIND && link.targetId === botId,
  );
  const share = useSave({
    // A link cannot be shown again, so sharing again replaces the live ones with a fresh link.
    save: async (replaced: string[], send) => {
      await Promise.all(replaced.map((id) => send("dozoShareLinks/revoke", { id })));
      return send("dozoShareLinks/create", {
        kind: DOZO_STATS_SHARE_KIND,
        targetId: botId,
        days: DOZO_SHARE_LINK_MAX_DAYS,
      });
    },
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
      <SettingsRow title={t`Tasks`} value={formatDozoStat(stats.tasksFinished, stats.more)} />
      <SettingsRow title={t`Routine runs`} value={formatDozoStat(stats.routineRuns, stats.more)} />
      <SettingsRow title={t`Skills`} value={formatDozoStat(stats.skillsLearned, stats.more)} />
      <SettingsRow title={t`Days active`} value={formatDozoStat(stats.daysActive, stats.more)} />
      {linksQuery.isError ? (
        <LoadFailure message={t`Could not load`} onRetry={() => void linksQuery.refetch()} />
      ) : (
        <>
          <SettingsRow
            accessibilityRole="button"
            title={t`Share card`}
            disabled={share.pending || stop.pending || links === undefined}
            onPress={() => share.run((live ?? []).map((link) => link.id))}
          />
          {live?.length ? (
            <SettingsRow
              accessibilityRole="button"
              title={t`Stop sharing`}
              disabled={share.pending || stop.pending}
              onPress={() => stop.run(live.map((link) => link.id))}
            />
          ) : null}
        </>
      )}
    </SettingsGroup>
  );
}
