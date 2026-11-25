import { useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import { useQuery } from "@tanstack/react-query";
import { Alert } from "react-native";
import { dateLocaleForUi, useUiLocale } from "../lib/i18n/i18n";
import { accountRpcQuery, queryClient, useSave } from "../lib/query/query";
import { useRosterSignals } from "../lib/api/roster-signals";
import { ACCOUNT_SETTINGS } from "../lib/query/settings-target";
import { errorText } from "../lib/user-error";
import { SettingsGroup, SettingsSwitch } from "./settings/settings-group";

/**
 * The model pool on a connection's page, as the web app has it: one switch, offered only where the
 * server says two or more of the provider's connections can hand a run over to each other, and
 * when this one opens again while it rests. The pool is the person's, read once per session and
 * again on the roster signal a change sends.
 */
export function DozoModelPoolSwitch({ credentialId }: { credentialId: string }) {
  const { t } = useLingui();
  const locale = dateLocaleForUi(useUiLocale());
  const read = accountRpcQuery("dozoModelPool/get");
  const pool = useQuery(read, queryClient);
  useRosterSignals(() => queryClient.invalidateQueries({ queryKey: read.queryKey }), true);
  const save = useSave({
    target: ACCOUNT_SETTINGS,
    save: (pooled: boolean, send) => send("dozoModelPool/set", { credentialId, pooled }),
    stale: [read.queryKey],
    onFailed: (error) => Alert.alert(t`Could not save`, errorText(error, t`Try again.`)),
  });
  const connection = pool.data?.connections.find((entry) => entry.credentialId === credentialId);
  const opens = connection?.opensAt ? Date.parse(connection.opensAt) : Number.NaN;
  const now = useNow(opens > Date.now() ? 60_000 : null);
  if (!connection) return null;
  const pooled = save.pending ? Boolean(save.input) : connection.pooled;
  let detail: string | undefined;
  if (opens > now) {
    const sameDay = new Date(opens).toDateString() === new Date(now).toDateString();
    const time = new Intl.DateTimeFormat(locale, {
      ...(sameDay ? {} : { month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    }).format(opens);
    detail = t`Opens at ${time}`;
  }
  return (
    <SettingsGroup>
      <SettingsSwitch
        label={t`Use the next connection when one runs out`}
        detail={detail}
        value={pooled}
        disabled={save.pending}
        onChange={(on) => save.run(on)}
      />
    </SettingsGroup>
  );
}
