import { useLingui } from "@lingui/react/macro";
import type { UsageSummary } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { queryClient, rpcQuery } from "../lib/query";
import { SettingsRow } from "./settings-group";

export const commandRulesRead = () => rpcQuery("dozoCommandRules/list");

/**
 * Settings' Commands row: the commands the member always allows a bot to run on their own
 * computer in this Space. Nothing shows until there is one, as on the web.
 */
export function DozoCommandsRow({
  disabled,
  leading,
  onPress,
}: {
  disabled?: boolean;
  leading?: ReactNode;
  onPress: () => void;
}) {
  const { t } = useLingui();
  const rules = useQuery({ ...commandRulesRead(), refetchOnMount: "always" }, queryClient).data;
  if (!rules?.length) return null;
  return (
    <SettingsRow
      accessibilityRole="button"
      chevron="right"
      disabled={disabled}
      leading={leading}
      onPress={onPress}
      title={t`Commands`}
      value={String(rules.length)}
    />
  );
}

/** The Usage row opens the grouped spend once there is some to group. */
export function dozoUsageLink(usage: UsageSummary | null | undefined, open: () => void) {
  return usage?.models?.length
    ? { accessibilityRole: "button" as const, chevron: "right" as const, onPress: open }
    : {};
}
