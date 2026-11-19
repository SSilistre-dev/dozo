import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoTeachValue, TaughtSkill } from "@rakazo/contracts";
import { savedSkillLiterals, TEACH_NAME_TAKEN } from "@rakazo/core";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { useMemo, useState } from "react";
import type { TeachValueChoice } from "../../components/teach/dozo-teach-value-row";
import {
  defaultValueName,
  TeachValueRow,
  valueDecisionOf,
} from "../../components/teach/dozo-teach-value-row";
import { useSave, useSpaceQueries } from "../../lib/query";
import { errorCode, errorText } from "../../lib/user-error";

/**
 * A saved skill whose steps still type text verbatim (saved before values were decided about):
 * one Review marker that opens each such value with the same choices as a draft's. Its steps are
 * already shown to everyone in the Space, so the values are shown as they are.
 */
export function SavedValuesReview({ skill }: { skill: TaughtSkill }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const values = useMemo<DozoTeachValue[]>(
    () => savedSkillLiterals(skill.playbook).values,
    [skill.playbook],
  );
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Record<string, TeachValueChoice>>({});
  const choiceOf = (value: DozoTeachValue) =>
    choices[value.placeholder] ?? { action: "variable", name: defaultValueName(value.placeholder) };
  const decide = useSave<void, TaughtSkill>({
    save: (_input, rpc) =>
      rpc.dozoTeach.decideSaved({
        skillId: skill.id,
        steps: skill.playbook.steps,
        decisions: Object.fromEntries(
          values.map((value) => [
            value.placeholder,
            valueDecisionOf(value.placeholder, choiceOf(value)),
          ]),
        ),
      }),
    stale: [queries.skills.list.key()],
    onSaved: () => setOpen(false),
  });
  if (!values.length) return null;
  const error = decide.error
    ? errorCode(decide.error) === TEACH_NAME_TAKEN
      ? t`Each name can be used once.`
      : errorText(decide.error, t`Could not save skill`)
    : null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        decide.reset();
        setOpen(next);
      }}
    >
      <PopoverTrigger
        data-testid="dozo-saved-values-review"
        render={<Button variant="outline" size="xs" className="shrink-0" />}
      >
        <Trans>Review</Trans>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[min(520px,calc(100vw-2rem))]">
        <div className="flex flex-col gap-2">
          {values.map((value) => (
            <TeachValueRow
              key={value.placeholder}
              value={value}
              choice={choiceOf(value)}
              busy={decide.pending}
              onChange={(choice) =>
                setChoices((current) => ({ ...current, [value.placeholder]: choice }))
              }
            />
          ))}
        </div>
        {error ? (
          <div role="alert" className="text-body-sm text-destructive">
            {error}
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button disabled={decide.pending} onClick={() => decide.run()}>
            <Trans>Save</Trans>
          </Button>
          <Button variant="outline" onClick={() => setOpen(false)}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
