import { useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import { useQuery } from "@tanstack/react-query";
import { dateLocaleForUi, useUiLocale } from "./i18n/i18n";
import { accountRpcQuery, queryClient } from "./query/query";
import { useRosterSignals } from "./api/roster-signals";

/**
 * Which of the person's models rest now, after their quota ran out or their key was refused, as a
 * model row's detail: when it opens again, in the pool's own words. Read again on the roster
 * signal a new rest sends.
 *
 * The phone has its own copy of these few lines (apps/mobile/lib/dozo-model-rests.ts and
 * apps/web/src/pages/model-settings/dozo-model-rests.ts): a shared one in @rakazo/contracts would
 * ride the package's one entry into the web's first paint, which has no room for it.
 */
export function useDozoRestNote() {
  const { t } = useLingui();
  const locale = dateLocaleForUi(useUiLocale());
  // The pool's own read, which carries them: one cache entry for both.
  const read = accountRpcQuery("dozoModelPool/get");
  const rests = useQuery(read, queryClient).data?.rests;
  useRosterSignals(() => queryClient.invalidateQueries({ queryKey: read.queryKey }), true);
  const now = useNow(rests?.length ? 60_000 : null);
  return (credentialId: string | undefined, modelId: string): string | undefined => {
    if (!credentialId || !rests) return undefined;
    const opens = Math.max(
      ...rests
        .filter(
          (rest) =>
            rest.credentialId === credentialId && (rest.modelId === modelId || !rest.modelId),
        )
        .map((rest) => Date.parse(rest.opensAt)),
    );
    if (!(opens > now)) return undefined;
    const sameDay = new Date(opens).toDateString() === new Date(now).toDateString();
    const time = new Intl.DateTimeFormat(locale, {
      ...(sameDay ? {} : { month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    }).format(opens);
    return t`Opens at ${time}`;
  };
}
