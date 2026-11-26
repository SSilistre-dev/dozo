import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { SettingsRow } from "../components/settings/settings-group";
import { currentApiBase, subscribeApiBase } from "./api/api";
import { calendarAvailable } from "./dozo-phone-calendar";
import { isRelayServer } from "./dozo-relay-endpoint";

/**
 * Settings' Phone row. Only on a direct server (the relay carries no device connection) and in a
 * build that has the calendar module.
 */
export function DozoPhoneRow({
  disabled,
  leading,
  onPress,
}: {
  disabled?: boolean;
  leading?: ReactNode;
  onPress: () => void;
}) {
  const { t } = useLingui();
  const apiBase = useSyncExternalStore(subscribeApiBase, currentApiBase, currentApiBase);
  if (isRelayServer(apiBase) || !calendarAvailable()) return null;
  return (
    <SettingsRow
      accessibilityRole="button"
      chevron="right"
      disabled={disabled}
      leading={leading}
      onPress={onPress}
      title={t`Phone`}
    />
  );
}
