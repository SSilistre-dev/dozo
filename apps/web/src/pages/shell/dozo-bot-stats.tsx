import { Trans, useLingui } from "@lingui/react/macro";
import { DOZO_SHARE_LINK_MAX_DAYS, DOZO_STATS_SHARE_KIND } from "@rakazo/contracts";
import { Button, toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { toastError } from "../../lib/dozo-error-text";
import { useQueryUserId, useSave } from "../../lib/query/query";
import { useSpaceRpc } from "../../lib/query/space-rpc";

/**
 * What the bot has done, in four numbers, with a button to share them as a card or stop sharing.
 * Only the bot's owner reads them: for anyone else the read is refused and nothing shows. The
 * card's link is shown once, when it is made, so it is copied then.
 */
export default function DozoBotStats({ botId, spaceId }: { botId: string; spaceId: string }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const userId = useQueryUserId();
  const statsKey = ["dozoBotStats", userId, spaceId, botId];
  const linksKey = ["dozoBotStats", "links", userId, spaceId];
  const stats = useQuery({
    queryKey: statsKey,
    queryFn: () => rpc.dozoBotStats.get({ botId }),
    retry: false,
  }).data;
  const links = useQuery({
    queryKey: linksKey,
    queryFn: () => rpc.dozoShareLinks.list(),
    enabled: Boolean(stats),
  }).data?.links;
  const live = links?.filter(
    (link) => link.kind === DOZO_STATS_SHARE_KIND && link.targetId === botId,
  );
  const share = useSave({
    save: (_: void, client) =>
      client.dozoShareLinks.create({
        kind: DOZO_STATS_SHARE_KIND,
        targetId: botId,
        days: DOZO_SHARE_LINK_MAX_DAYS,
      }),
    stale: [linksKey],
    onSaved: async ({ url }) => {
      try {
        await navigator.clipboard.writeText(url);
        toast.success(t`Link copied`);
      } catch {
        toast(url);
      }
    },
    onFailed: (error) => toastError(t`Could not share`, error),
  });
  const stop = useSave({
    save: (ids: string[], client) =>
      Promise.all(ids.map((id) => client.dozoShareLinks.revoke({ id }))),
    stale: [linksKey],
    onFailed: (error) => toastError(t`Could not save`, error),
  });
  if (!stats) return null;
  const figures = [
    { key: "tasks", label: <Trans>Tasks</Trans>, value: stats.tasksFinished },
    { key: "routines", label: <Trans>Routine runs</Trans>, value: stats.routineRuns },
    { key: "skills", label: <Trans>Skills</Trans>, value: stats.skillsLearned },
    { key: "days", label: <Trans>Days active</Trans>, value: stats.daysActive },
  ];
  return (
    <div className="flex flex-col gap-2 py-2" data-testid="dozo-bot-stats">
      <dl className="grid grid-cols-4 gap-2">
        {figures.map(({ key, label, value }) => (
          <div key={key} className="flex min-w-0 flex-col-reverse">
            <dt className="truncate text-body-sm text-muted-foreground">{label}</dt>
            <dd className="text-body font-medium tabular-nums text-foreground">
              {value.toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>
      {live?.length ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground"
          disabled={stop.pending}
          onClick={() => stop.run(live.map((link) => link.id))}
        >
          <Trans>Stop sharing</Trans>
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground"
          disabled={share.pending || links === undefined}
          onClick={() => share.run()}
        >
          <Trans>Share card</Trans>
        </Button>
      )}
    </div>
  );
}
