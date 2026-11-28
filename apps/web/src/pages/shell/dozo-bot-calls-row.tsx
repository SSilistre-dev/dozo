import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { toastError } from "../../lib/dozo-error-text";
import { useQueryUserId, useSave } from "../../lib/query/query";
import { useSpaceRpc } from "../../lib/query/space-rpc";
import { SwitchRow } from "./bots/bot-settings-sections";

/**
 * Whether the bot may ring you from a routine, in its settings. Off by default; nothing shows
 * where calls are not available (the server has them off, no voice is connected, or the bot is
 * not yours). Under the model pool's key, so the roster signal a change sends from any of your
 * devices reads it again (as the bot's backups do).
 */
export function DozoBotCallsRow({ botId, spaceId }: { botId: string; spaceId: string }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const key = ["dozoModelPool", "botCalls", useQueryUserId(), spaceId, botId];
  const calls = useQuery({ queryKey: key, queryFn: () => rpc.dozoBotCalls.get({ botId }) }).data;
  const save = useSave({
    save: (allowed: boolean, client) => client.dozoBotCalls.set({ botId, allowed }),
    stale: [key],
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
