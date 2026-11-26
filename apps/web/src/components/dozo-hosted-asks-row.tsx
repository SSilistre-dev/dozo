import { useLingui } from "@lingui/react/macro";
import { Label, Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query/query";
import { SettingsRow } from "./settings/SettingsRows";

/**
 * Whether commands that change something on the bot's computer ask first, under the account's
 * approval mode. Shown only once read, and only where the Space has a computer of the bot's.
 */
export function DozoHostedAsksRow() {
  const { t } = useLingui();
  const switchId = useId();
  const queries = useSpaceQueries();
  const hosted = useQuery({
    ...queries.dozoCommandRules.getHostedAsks.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  const save = useSave({
    save: (hostedAsks: boolean, rpc) => rpc.dozoCommandRules.setHostedAsks({ hostedAsks }),
    stale: [queries.dozoCommandRules.getHostedAsks.key()],
    onFailed: (error) => toastError(t`Couldn't update this setting`, error),
  });
  const read = hosted.data?.hostedAsks;
  if (read === undefined || read === null) return null;
  const asks = save.pending ? Boolean(save.input) : read;
  return (
    <div data-testid="dozo-hosted-asks">
      <SettingsRow
        label={
          <Label htmlFor={switchId} className="text-body font-normal text-foreground">
            {t`Ask before commands on bot computers`}
          </Label>
        }
        control={
          <Switch
            id={switchId}
            checked={asks}
            disabled={save.pending}
            onCheckedChange={(on) => save.run(on)}
          />
        }
      />
    </div>
  );
}
