import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Alert } from "react-native";
import { queryClient, rpcQuery, useSave } from "../lib/query";
import { errorText } from "../lib/user-error";
import { NativeSwitch } from "./native-switch";
import { SettingsRow } from "./settings-group";

/**
 * Whether commands that change something on the bot's computer ask first, under the account's
 * approval mode, as the web app's row. Shown once read, and only where the Space has a computer
 * of the bot's.
 */
export function DozoHostedAsksRow({ leading }: { leading?: ReactNode }) {
  const { t } = useLingui();
  const read = rpcQuery("dozoCommandRules/getHostedAsks");
  const hosted = useQuery({ ...read, refetchOnMount: "always" }, queryClient);
  const save = useSave({
    save: (hostedAsks: boolean, send) => send("dozoCommandRules/setHostedAsks", { hostedAsks }),
    stale: [read.queryKey],
    onFailed: (error) =>
      Alert.alert(t`Couldn't update this setting`, errorText(error, t`Try again.`)),
  });
  const value = hosted.data?.hostedAsks;
  if (value === undefined || value === null) return null;
  const title = t`Ask before commands on bot computers`;
  return (
    <SettingsRow
      dimmed={save.pending}
      leading={leading}
      title={title}
      trailing={
        <NativeSwitch
          accessibilityLabel={title}
          disabled={save.pending}
          onValueChange={(on) => save.run(on)}
          value={save.pending ? Boolean(save.input) : value}
        />
      }
    />
  );
}
