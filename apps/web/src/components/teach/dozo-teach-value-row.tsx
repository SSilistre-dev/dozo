import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoTeachValue, DozoTeachValueDecision } from "@rakazo/contracts";
import { Input, ToggleGroup, ToggleGroupItem } from "@rakazo/ui-web";

export type TeachValueAction = DozoTeachValueDecision["action"];
export type TeachValueChoice = { action: TeachValueAction; name: string };

/** `{{value 3}}` names its input `value_3` until someone names it. */
export function defaultValueName(placeholder: string): string {
  return `value_${placeholder.replace(/\D/g, "")}`;
}

export function valueDecisionOf(
  placeholder: string,
  choice: TeachValueChoice,
): DozoTeachValueDecision {
  if (choice.action === "fixed" || choice.action === "remove") return { action: choice.action };
  return { action: choice.action, name: choice.name.trim() || defaultValueName(placeholder) };
}

/**
 * One typed value and what becomes of it: an input asked for on each run, an input typed from a
 * saved login (hidden), kept as typed (with who sees it then), or dropped. Protected input and
 * text that could not be rebuilt are masked and can never be kept as text.
 */
export function TeachValueRow({
  value,
  choice,
  busy,
  onChange,
}: {
  value: DozoTeachValue;
  choice: TeachValueChoice;
  busy: boolean;
  onChange: (choice: TeachValueChoice) => void;
}) {
  const { t } = useLingui();
  const hidden = value.secret || value.text === null;
  const named = choice.action === "variable" || choice.action === "hidden";
  return (
    <div data-testid="skill-draft-value">
      <div className="flex items-center gap-2">
        <span dir="auto" className="w-28 shrink-0 break-words text-body-sm text-muted-foreground">
          {hidden ? "••••••" : value.text}
        </span>
        {named ? (
          <Input
            aria-label={t`Name`}
            disabled={busy}
            className="min-w-0 flex-1"
            value={choice.name}
            onChange={(event) => onChange({ ...choice, name: event.target.value })}
          />
        ) : (
          <span className="flex-1" />
        )}
        <ToggleGroup
          value={[choice.action]}
          disabled={busy}
          onValueChange={([next]) => {
            if (next) onChange({ ...choice, action: next as TeachValueAction });
          }}
          spacing={0}
          size="sm"
          variant="outline"
        >
          <ToggleGroupItem value="variable">
            <Trans>Variable</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem value="hidden">
            <Trans>Hidden</Trans>
          </ToggleGroupItem>
          {hidden ? null : (
            <ToggleGroupItem value="fixed">
              <Trans>Fixed</Trans>
            </ToggleGroupItem>
          )}
          <ToggleGroupItem value="remove">
            <Trans>Remove</Trans>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {choice.action === "fixed" ? (
        <p className="mt-1 text-label text-muted-foreground">
          <Trans>Saved in the steps, visible to everyone in this space.</Trans>
        </p>
      ) : null}
    </div>
  );
}
