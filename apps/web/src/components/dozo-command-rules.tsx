import { useLingui } from "@lingui/react/macro";
import { commandWordsLabel } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/**
 * The commands the member always allows a bot to run on their own computer in this Space, under
 * Approvals, each with the bot and folder it is for. Nothing shows until there is one.
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
  if (!rules.data?.length) return null;
  return (
    <SettingsGroup title={t`Commands`} data-testid="dozo-command-rules">
      {rules.data.map((rule) => {
        const label = commandWordsLabel(rule.words);
        return (
          <SettingsRow
            key={rule.id}
            label={
              <div className="min-w-0">
                <code className="block truncate font-mono text-body-sm">{label}</code>
                <p className="flex gap-2 text-body-sm text-muted-foreground">
                  <span className="truncate">{rule.botName}</span>
                  {rule.cwd ? <span className="truncate font-mono">{rule.cwd}</span> : null}
                </p>
              </div>
            }
            control={
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
            }
          />
        );
      })}
    </SettingsGroup>
  );
}
