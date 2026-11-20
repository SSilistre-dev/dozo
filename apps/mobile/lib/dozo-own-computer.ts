import { t } from "@lingui/core/macro";
import type { ComputerMode } from "@rakazo/contracts";
import { ownComputerNote } from "@rakazo/contracts";
import { planLimitCopy } from "@rakazo/i18n/run-error";
import { useQuery } from "@tanstack/react-query";
import { rpcQuery } from "./query";

/**
 * The line under the bot's Own computer switch (`ownComputerNote`): on a plan with no computer,
 * why the switch is off and cannot be turned on; on a Team Computer, that it is shared.
 */
export function useOwnComputerSwitch(mode: ComputerMode): {
  detail: string | undefined;
  disabled: boolean;
} {
  const billing = useQuery(rpcQuery("billing/status")).data;
  const note = ownComputerNote(mode, billing, planLimitCopy());
  if (note === "shared") {
    return {
      detail: t`Shared with this Space's other bots, files and sign-ins included.`,
      disabled: false,
    };
  }
  return { detail: note?.text, disabled: note !== null };
}
