import { useLingui } from "@lingui/react/macro";
import { DOZO_DAILY_SEND_CHOICES } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Alert, View } from "react-native";
import { native } from "../lib/native/native";
import { queryClient, rpcQuery, useSave } from "../lib/query/query";
import { errorText } from "../lib/api/user-error";
import { MenuPickerMenu } from "./ui/menu-picker";
import { NativeSymbol } from "./native/native-symbol";
import { SettingsRow } from "./settings/settings-group";

/**
 * How many sends each bot makes a day without asking, under the account's approval mode; past it,
 * each send asks. As the web app's row under approvals, a native menu of the same choices; it
 * shows once the number is read, so a failed read leaves the row out.
 */
export function DozoSendLimitRow({ leading }: { leading?: ReactNode }) {
  const { t } = useLingui();
  const read = rpcQuery("dozoSendLimit/get");
  const limit = useQuery({ ...read, refetchOnMount: "always" }, queryClient);
  const save = useSave({
    save: (dailySends: number, send) => send("dozoSendLimit/set", { dailySends }),
    stale: [read.queryKey],
    onFailed: (error) =>
      Alert.alert(t`Couldn't update daily sends`, errorText(error, t`Try again.`)),
  });
  const value = save.pending ? save.input : limit.data?.dailySends;
  if (value === undefined) return null;
  const choices: number[] = [...DOZO_DAILY_SEND_CHOICES];
  if (!choices.includes(value)) choices.push(value);
  choices.sort((a, b) => a - b);
  return (
    <MenuPickerMenu
      choices={choices.map((choice) => ({ key: String(choice), label: String(choice) }))}
      disabled={save.pending}
      label={t`Daily sends per bot`}
      onChange={(key) => save.run(Number(key))}
      value={String(value)}
    >
      <View>
        <SettingsRow
          accessible
          accessibilityRole="button"
          accessibilityState={{ disabled: save.pending }}
          dimmed={save.pending}
          leading={leading}
          title={t`Daily sends per bot`}
          trailing={
            <NativeSymbol
              android="chevron-expand"
              color={native.tertiaryLabel}
              ios="chevron.up.chevron.down"
              size={13}
            />
          }
          value={String(value)}
        />
      </View>
    </MenuPickerMenu>
  );
}
