import { Trans, useLingui } from "@lingui/react/macro";
import { OptionSelect } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { toastError } from "../../../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../../../lib/query/query";

/**
 * Which of the owner's other bots co-hosts the spoken briefing of a saved routine's results, or
 * Off. Shown only while a briefing can be spoken (the owner's voice connection speaks, and both
 * bots have a voice) or one is still set. A change is saved at once, as it is no part of the
 * routine's draft.
 */
export function DozoRoutineBriefing({
  routineId,
  fieldId,
}: {
  routineId: string;
  fieldId: string;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const read = queries.dozoSpokenBriefings.get;
  const briefing = useQuery(read.queryOptions({ input: { routineId } }));
  const save = useSave<string | null>({
    save: (coHostBotId, rpc) => rpc.dozoSpokenBriefings.set({ routineId, coHostBotId }),
    stale: [read.key({ input: { routineId } })],
    onFailed: (error) => toastError(t`Something went wrong. Try again.`, error),
  });
  const data = briefing.data;
  if (!data || (!data.available && data.coHostBotId === null)) return null;
  const coHostBotId = save.pending ? (save.input ?? null) : data.coHostBotId;
  return (
    <label htmlFor={`${fieldId}-briefing`} className="mt-5 block text-body text-muted-foreground">
      <Trans>Spoken briefing</Trans>
      <OptionSelect
        id={`${fieldId}-briefing`}
        className="mt-2 w-full"
        value={coHostBotId ?? ""}
        disabled={save.pending}
        options={[
          { value: "", label: t`Off` },
          ...data.coHosts.map((bot) => ({ value: bot.id, label: bot.name })),
        ]}
        onValueChange={(value) => save.run(value || null)}
      />
    </label>
  );
}
