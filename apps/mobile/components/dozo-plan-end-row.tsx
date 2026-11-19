import { useLingui } from "@lingui/react/macro";
import type { PlanEnd } from "@rakazo/contracts";
import { planEndDays, planEndWarns } from "@rakazo/contracts";
import { Text } from "react-native";
import { dateLocaleForUi } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { SettingsRow } from "./settings-group";

/**
 * When the plan in force renews or ends, and the days left, in the warning colour near its end. A
 * granted plan above a subscription says which plan follows instead.
 */
export function DozoPlanEndRow({ end }: { end: PlanEnd }) {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const day = new Date(end.at).toLocaleDateString(dateLocaleForUi(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const count = planEndDays(end);
  const remaining = t`${count} days`;
  const left = end.fallsTo
    ? `${end.fallsTo.from} → ${end.fallsTo.to}`
    : count <= 0
      ? t`Today`
      : count === 1
        ? t`Tomorrow`
        : t`${remaining} left`;
  return (
    <SettingsRow
      title={end.renews ? t`Renews` : t`Ends`}
      trailing={
        <Text
          testID="plan-end"
          style={{
            flexShrink: 1,
            fontSize: 17,
            color: planEndWarns(end) ? tokens.warning : native.secondaryLabel,
          }}
        >
          {`${day} · ${left}`}
        </Text>
      }
    />
  );
}
