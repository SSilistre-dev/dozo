import { Trans, useLingui } from "@lingui/react/macro";
import { dozoNightNotesChange, findDozoNightNotes } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { toastError } from "../../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { SwitchRow } from "./bots/bot-settings-sections";

/**
 * The bot's nightly memory note: one switch that creates or turns on the daily routine on this bot,
 * or turns it off, in the zone the person's account uses. The routine is an ordinary one: it shows
 * in the bot's routines, and quiet hours hold its run.
 */
export function DozoNightNotesRow({ botId }: { botId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const list = queries.routines.list.queryOptions({ input: { botId } });
  const routines = useQuery(list).data;
  const me = useQuery(queries.me.queryOptions()).data;
  const save = useSave({
    save: async (on: boolean, client) => {
      const change = dozoNightNotesChange(
        await client.routines.list({ botId }),
        botId,
        me?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        on,
      );
      if (change && "create" in change) await client.routines.create(change.create);
      else if (change) await client.routines.update(change.update);
    },
    stale: [list.queryKey],
    onFailed: (error) => toastError(t`Could not save`, error),
  });
  if (!routines) return null;
  const on =
    save.pending && save.input !== undefined
      ? save.input
      : Boolean(findDozoNightNotes(routines)?.active);
  return (
    <SwitchRow
      id={`night-notes-${botId}`}
      label={<Trans>Nightly memory note</Trans>}
      checked={on}
      disabled={save.pending}
      onChange={save.run}
    />
  );
}
