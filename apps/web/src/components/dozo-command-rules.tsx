import { useLingui } from "@lingui/react/macro";
import type { DozoCommandRule } from "@rakazo/contracts";
import { commandWordsLabel, prefixRuleAllowed } from "@rakazo/core";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query/query";
import { SettingsGroup, SettingsRow } from "./settings/SettingsRows";

type Effect = DozoCommandRule["effect"];

/**
 * The member's command rules for each bot in this Space, under Approvals: what each one does
 * (allow these words, allow them with arguments, or block them), the bot, and, for a rule that
 * allows, the folder and whether it is for the bot's computer. Nothing shows until there is one.
 */
export function DozoCommandRules() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const rules = useQuery({
    ...queries.dozoCommandRules.list.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  const remove = useSave({
    save: (id: string, rpc) => rpc.dozoCommandRules.remove({ id }),
    stale: [queries.dozoCommandRules.list.key()],
    onFailed: (error) => toastError(t`Could not remove rule`, error),
  });
  const update = useSave({
    save: (input: { id: string; effect: Effect }, rpc) => rpc.dozoCommandRules.update(input),
    stale: [queries.dozoCommandRules.list.key()],
    onFailed: (error) => toastError(t`Could not update rule`, error),
  });
  if (!rules.data?.length) return null;
  return (
    <SettingsGroup title={t`Commands`} data-testid="dozo-command-rules">
      {rules.data.map((rule) => {
        const label = commandWordsLabel(rule.words);
        const effect =
          update.pending && update.input?.id === rule.id ? update.input.effect : rule.effect;
        const allows = effect !== "block";
        return (
          <SettingsRow
            key={rule.id}
            label={
              <div className="min-w-0">
                <code className="block truncate font-mono text-body-sm">
                  {effect === "allow_prefix" ? `${label} …` : label}
                </code>
                <p className="flex gap-2 text-body-sm text-muted-foreground">
                  <span className="truncate">{rule.botName}</span>
                  {allows && rule.cwd ? (
                    <span className="truncate font-mono">{rule.cwd}</span>
                  ) : null}
                  {allows && rule.computer === "hosted" ? (
                    <span className="truncate">{t`Bot computer`}</span>
                  ) : null}
                </p>
              </div>
            }
            control={
              <>
                <NativeSelect
                  aria-label={t`What ${label} does`}
                  value={effect}
                  disabled={update.pending}
                  onChange={(event) =>
                    update.run({ id: rule.id, effect: event.target.value as Effect })
                  }
                  className="w-48"
                >
                  <NativeSelectOption value="allow">{t`Allow`}</NativeSelectOption>
                  {prefixRuleAllowed(rule.words, rule.cwd) || effect === "allow_prefix" ? (
                    <NativeSelectOption value="allow_prefix">
                      {t`Allow with arguments`}
                    </NativeSelectOption>
                  ) : null}
                  <NativeSelectOption value="block">{t`Block`}</NativeSelectOption>
                </NativeSelect>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Remove ${label}`}
                  className="text-destructive hover:text-destructive"
                  disabled={remove.pending}
                  onClick={() => remove.run(rule.id)}
                >
                  <Trash2 />
                </Button>
              </>
            }
          />
        );
      })}
    </SettingsGroup>
  );
}
