import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { toastError } from "../../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { SwitchRow } from "./bots/bot-settings-sections";

/**
 * Whether the bot may ring you from a routine, in its settings. Off by default; nothing shows
 * where calls are not available (the server has them off, no voice is connected, or the bot is
 * not yours).
 */
export function DozoBotCallsRow({ botId }: { botId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const read = queries.dozoBotCalls.get.queryOptions({ input: { botId } });
  const calls = useQuery(read).data;
  const save = useSave({
    save: (allowed: boolean, rpc) => rpc.dozoBotCalls.set({ botId, allowed }),
    stale: [read.queryKey],
    onFailed: (error) => toastError(t`Could not save`, error),
  });
  if (!calls?.available) return null;
  return (
    <SwitchRow
      id={`dozo-bot-calls-${botId}`}
      label={t`Can call me`}
      checked={save.pending ? Boolean(save.input) : calls.allowed}
      disabled={save.pending}
      onChange={(allowed) => save.run(allowed)}
    />
  );
}
